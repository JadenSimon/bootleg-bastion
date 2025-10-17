import * as aws from 'terraform-provider:aws'
import * as core from 'synapse:core'
import * as child_process from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { Bundle } from 'synapse:lib'

// yup.
const selfIpv4 = core.defineDataSource(async () => {
    const resp = await fetch('https://checkip.amazonaws.com/')
    if (resp.status !== 200) {
        throw new Error(`failed to get own ip: ${resp.statusText} [status: ${resp.status}]`)
    }

    return (await resp.text()).trim()
})

export function createVpc() {
    const vpc = new aws.Vpc({
        cidrBlock: '10.0.0.0/16',
    })

    const igw = new aws.InternetGateway({
        vpcId: vpc.id,
    })

    const zones = new aws.AvailabilityZonesData({
        state: 'available',
        filter: [{
            name: 'opt-in-status',
            values: ['opt-in-not-required']
        }]
    })

    const publicSubnet = new aws.Subnet({
        vpcId: vpc.id,
        cidrBlock: '10.0.0.0/24',
        mapPublicIpOnLaunch: true,
        availabilityZone: zones.names[0],
    })

    const privateSubnet = new aws.Subnet({
        vpcId: vpc.id,
        cidrBlock: '10.0.1.0/24',
        mapPublicIpOnLaunch: false,
        availabilityZone: zones.names[1],
    })
    
    const publicRoute = new aws.Route({
        routeTableId: vpc.defaultRouteTableId,
        destinationCidrBlock: '0.0.0.0/0',
        gatewayId: igw.id,
    })

    const sshIngressRule = new aws.VpcSecurityGroupIngressRule({
        securityGroupId: vpc.defaultSecurityGroupId,
        ipProtocol: 'tcp',
        fromPort: 22,
        toPort: 22,
        cidrIpv4: `${selfIpv4()}/32`,
    })

    // attaching everything that makes the subnet "public" as explicit deps
    core.addDependencies(publicSubnet, igw, publicRoute, sshIngressRule)

    return {
        vpc,
        privateSubnet,
        publicSubnet,
    }
}

// not pinned. will probably break something at some point.
// but that's half the fun.
const ubuntuAmi = new aws.AmiData({
    mostRecent: true,
    owners: ['099720109477'],
    filter: [{
        name: 'name',
        values: ['ubuntu/images/hvm-ssd/ubuntu-*-*-amd64-server-*'],
    }]
})

export interface Ec2Params {
    subnet: aws.Subnet
    instanceType?: string
    startFn: () => Promise<void> | void
    deployProxy?: Ec2Instance
}

export class Ec2Instance {
    public readonly resource: aws.Instance
    public readonly publicIpv4: string
    public readonly privateIpv4: string
    public readonly deployment: VerySecureCodeDeployment
    public readonly keys = new KeyPair()

    public constructor(params: Ec2Params) {
        const netInt = new aws.NetworkInterface({
            subnetId: params.subnet.id,
        })

        // we're going to be uploading bundled scripts directly, so we need a runtime on the machine
        // note: this is only executed once, changing this requires replacing the instance (=slow!)
        //
        // also no clue what i was thinking when i wrote this script. all well.
        const initScript = `
#!/bin/bash
PROFILE=/dev/null bash -c 'wget -qO- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.3/install.sh | bash'
NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"
nvm install 24
cp "$(which node)" /usr/bin/node
chmod 755 /usr/bin/node
rm -rf $NVM_DIR
`.trim()

        this.resource = new aws.Instance({
            ami: ubuntuAmi.id,
            instanceType: params.instanceType ?? 't2.micro',
            primaryNetworkInterface: {
                networkInterfaceId: netInt.id,
            },
            rootBlockDevice: {
                volumeSize: 30,
            },
            // proxy deployment will add `node` for us
            userData: !params.deployProxy ? initScript : undefined,
            keyName: this.keys.awsPair.keyName,
        })

        // these can technically "drift" if the EC2 instance is power cycled (possibly other cases too?)
        // you could solve this statically by allocating addresses up front, separate from instance lifecycle
        // or dynamically, maybe by running some code on machine init to introspect and update a shared store
        this.publicIpv4 = this.resource.publicIp
        this.privateIpv4 = this.resource.privateIp

        const bundle = new Bundle(params.startFn, {
            immediatelyInvoke: true,
        })

        const addr = params.deployProxy ? this.privateIpv4 : this.publicIpv4
        this.deployment = new VerySecureCodeDeployment(bundle, addr, this.keys.localPair.privateKeyPath, params.deployProxy ? {
            addr: params.deployProxy.publicIpv4,
            key: params.deployProxy.keys.localPair.privateKeyPath,
        } : undefined)
    }
}

// we need to copy over the private key
// not going to use SSH jump hosts or ProxyCommand
// but let's not leave our private keys lying around
async function runWithTmpKey<T>(
    targetKey: string,
    proxyKey: string,
    proxyAddr: string,
    cb: (newKeyPath: string) => Promise<T> | T
) {
    const newKeyPath = path.resolve('/home/ubuntu/.ssh', path.basename(targetKey))
    await retryForABit(15_000, () => scpToRemote(proxyKey, proxyAddr, targetKey, newKeyPath))

    try {
        return await cb(newKeyPath)
    } finally {
        await runRemoteCmd(proxyKey, proxyAddr, `rm ${newKeyPath}`)
    }
}

export async function getServiceStatus(host: Ec2Instance, proxy?: Ec2Instance) {
    const cmd = `systemctl status ${systemdUnitName}.service --no-pager`
    if (!proxy) {
        return runRemoteCmd(host.keys.localPair.privateKeyPath, host.publicIpv4, cmd)
    }

    const proxyKey = proxy.keys.localPair.privateKeyPath
    const spawnFn = createRemoteSpawnFn(proxyKey, proxy.publicIpv4)

    const keyPath = host.keys.localPair.privateKeyPath
    const r = await runWithTmpKey(
        keyPath,
        proxyKey,
        proxy.publicIpv4,
        newKeyPath => runRemoteCmd(newKeyPath, host.privateIpv4, cmd, spawnFn),
    )

    return r
}

// some polling code, it's basically Kubernetes now... right? right??
export async function retryForABit<T>(duration: number, cb: () => Promise<T>) {
    let sleepTime = Math.max(1, duration/64)
    const start = Date.now()
    while (true) {
        let didCatch = false
        const maybeError = await cb().catch(err => {
            didCatch = true
            return err
        })
        if (!didCatch) {
            return maybeError as T
        }

        if ((Date.now() - start) > duration) {
            console.log('timed out :(')
            throw maybeError
        }

        console.log('taking a nap and then reconciling state i guess?')
        sleepTime = Math.min(duration/4, sleepTime * 2)
        await new Promise<void>(r => setTimeout(r, sleepTime))
    }
}

async function deployToInstance(
    entrypointPath: string,
    hostAddr: string,
    keyPath: string
) {
    const entryDest = '/home/ubuntu/entry.js'

    // normally you'd want "status checks" apart of the graph but eh this works
    await retryForABit(30_000, () => scpToRemote(keyPath, hostAddr, entrypointPath, entryDest))
    await retryForABit(15_000, () => runRemoteCmd(keyPath, hostAddr, 'node -v'))

    await runRemoteCmd(keyPath, hostAddr, `sudo systemd-run --unit=${systemdUnitName} node ${entryDest}`)
}

const systemdUnitName = 'test'

async function deployToInstanceViaProxy(
    entrypointPath: string,
    hostAddr: string,
    keyPath: string,
    proxyAddr: string,
    proxyKeyPath: string
) {
    // brittle, of course
    const proxyEntryDest = '/home/ubuntu/proxy-entry.js'
    await retryForABit(60_000, () => scpToRemote(proxyKeyPath, proxyAddr, entrypointPath, proxyEntryDest))

    await runWithTmpKey(keyPath, proxyKeyPath, proxyAddr, async newKeyPath => {
        const spawnFn = createRemoteSpawnFn(proxyKeyPath, proxyAddr)
        const entryDest = '/home/ubuntu/entry.js'
        
        await retryForABit(30_000, () => scpToRemote(newKeyPath, hostAddr, proxyEntryDest, entryDest, spawnFn))

        // let's copy over the node binary too, we didn't add NAT
        await retryForABit(30_000, () => scpToRemote(newKeyPath, hostAddr, '/usr/bin/node', '/home/ubuntu/node', spawnFn))

        await runRemoteCmd(newKeyPath, hostAddr, `sudo systemd-run --unit=${systemdUnitName} /home/ubuntu/node ${entryDest}`, spawnFn)
    })
}

async function createDeployment(bundle: Bundle, addr: string, keyPath: string, deployProxy?: { addr: string; key: string }) {
    const bundleHash = path.basename(bundle.destination)
    const entrypointPath = await core.getArtifactFs().resolveArtifact(bundle.destination)

    if (deployProxy) {
        await deployToInstanceViaProxy(entrypointPath, addr, keyPath, deployProxy.addr, deployProxy.key)
    } else {
        await deployToInstance(entrypointPath, addr, keyPath)
    }

    return { addr, keyPath, bundleHash, deployProxy }
}

async function deleteDeployment(addr: string, keyPath: string, deployProxy?: { addr: string; key: string }) {
    // it's okay to make the deletion code more forgiving than you'd like it to be
    //
    // not because this is the best way to write software, but because distributed 
    // systems are messy. While the possibility of leaving dangling resources is bad, 
    // this tradeoff is made in favor of robustness. We cannot be precise until we
    // have full control of the underlying systems, much like modern processes rely 
    // on the stability of their own memory.
    const deleteCmd = `(sudo systemctl stop ${systemdUnitName}.service && sudo systemctl reset-failed ${systemdUnitName}.service) || true`
    if (!deployProxy) {
        await runRemoteCmd(keyPath, addr, deleteCmd)
        return
    }

    const proxyKeyPath = deployProxy.key
    const proxyAddr = deployProxy.addr

    const spawnFn = createRemoteSpawnFn(proxyKeyPath, proxyAddr)

    await runWithTmpKey(keyPath, proxyKeyPath, proxyAddr, async newKeyPath => {
        await runRemoteCmd(newKeyPath, addr, deleteCmd, spawnFn)
    })
}

class VerySecureCodeDeployment extends core.defineResource({
    create: createDeployment,
    update: async (state, ...params) => {
        const bundleHash = path.basename(params[0].destination)
        if (bundleHash === state.bundleHash && state.addr === params[1]) {
            return state
        }

        // assumption: ip changed means other ip doesn't exist
        // this is only true if we treat the instances as stateful (we do)
        if (state.addr === params[1]) {
            await deleteDeployment(state.addr, state.keyPath, state.deployProxy)
        }

        return createDeployment(...params)
    },
    delete: async state => {
        // XXX: currently a bug with custom resources, they don't store their deps correctly in specific cases
        // so for now, here's a sloppy `delete` implementation
        await Promise.race([
            deleteDeployment(state.addr, state.keyPath, state.deployProxy).catch(err => {
                console.log('failed to delete deployment', err)
            }),
            new Promise<void>(r => setTimeout(r, 15_000).unref()),
        ])
    },
}) {}

async function generateSshKeyPair() {
    const id = crypto.randomUUID()
    const dest = path.resolve('out', 'keys', id)

    await fs.promises.mkdir(path.dirname(dest), {
        recursive: true,
    })

    // ssh requires certain permissions for dir containing keys
    await fs.promises.chmod(path.dirname(dest), 0o700)

    await localSpawnFn('ssh-keygen', ['-t', 'rsa', '-b', '4096', '-q', '-N', '', '-f', dest])

    const publicKeyPath = dest + '.pub'

    return {
        id,
        publicKeyPath,
        privateKeyPath: dest,
    }
}

async function rm(p: string) {
    return fs.promises.rm(p).catch(err => {
        if ((err as { code: string}).code !== 'ENOENT') {
            throw err
        }
    })
}

const getSshArgs = (keypath: string) => [
    // ssh is rather unfriendly to programmatic use-cases
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=5',
    '-i', keypath
]

async function localSpawnFn(cmd: string, args: string[]) {
    return new Promise<string>((resolve, reject) => {
        const b: Buffer[] = []
        const proc = child_process.spawn(cmd, args, {
            stdio: 'pipe',
        })
        proc.once('error', reject)
        proc.once('close', (code, signal) => {
            if (code !== 0 || signal) {
                reject(new Error(`non-zero exit code or signal: ${code} [signal: ${signal}]`))
            } else {
                resolve(Buffer.concat(b).toString())
            }
        })
        proc.stdout.on('data', d => b.push(d))
        proc.stderr.on('data', d => {
            console.log(`[stderr <${cmd}>]:`, d.toString())
        })
    })
}

// _very_ brittle way to do this, but it doesn't involve any extra deps
function createRemoteSpawnFn(keyPath: string, host: string) {
    return function remoteSpawnFn(cmd: string, args: string[]) {
        const roughlyQuoted = args.map(x => x.includes(' ') ? `"${x}"` : x)
        return runRemoteCmd(keyPath, host, `${cmd} ${roughlyQuoted.join(' ')}`)
    }
}

async function runRemoteCmd(keyPath: string, host: string, cmd: string, spawnFn = localSpawnFn) {
    const args = [...getSshArgs(keyPath), `ubuntu@${host}`, cmd]

    return spawnFn('ssh', args)
}

async function scpToRemote(keyPath: string, host: string, from: string, to: string, spawnFn = localSpawnFn) {
    const args = [...getSshArgs(keyPath), from, `ubuntu@${host}:${to}`]

    return spawnFn('scp', args)
}

class LocalKeyPair extends core.defineResource({
    create: generateSshKeyPair,
    update: (state) => {
        // noop, hold onto our state even if `generateSshKeyPair` changes
        return state
    },
    delete: async state => {
        await Promise.all([
            rm(state.publicKeyPath),
            rm(state.privateKeyPath),
        ])
    },
}) {}

const publicKeyData = core.defineDataSource((p: string) => {
    return fs.promises.readFile(p, 'utf-8')
})

export class KeyPair {
    public readonly localPair: LocalKeyPair
    public readonly awsPair: aws.KeyPair

    constructor() {
        this.localPair = new LocalKeyPair()
        this.awsPair = new aws.KeyPair({
            publicKey: publicKeyData(this.localPair.publicKeyPath),
        })
    }
}
