import * as net from 'node:net'
import { createVpc, Ec2Instance, getServiceStatus, retryForABit } from './bootleg'

// A self-contained bastion, with code running on both machines
// ** not intended for production! **

const network = createVpc()

const myPort = 4567

const bootlegBastion = new Ec2Instance({
    subnet: network.publicSubnet,
    startFn: async () => {
        // you could avoid using retries here by implementing a separate 
        // resource to do a health check on the node, then attaching the
        // ip address to that resource instead
        const socket = await connectWithRetries(myPort, enterpriseEcho.deployment.addr)

        process.on('SIGTERM', () => socket.end())

        socket.on('data', d => console.log(d.toString()))

        let c = 0
        setInterval(() => {
            if (socket.writable) {
                socket.write(`hello, world! c: ${c++}`)
            }
        }, 5_000).unref()
    },
})

// this has zero public internet access and infinite configurability
const enterpriseEcho = new Ec2Instance({
    subnet: network.privateSubnet,
    deployProxy: bootlegBastion,
    startFn: async () => {
        await createTcpEchoServer(myPort)
        console.log('started echo server!')
    },
})

async function createTcpEchoServer(port: number) {
    const s = net.createServer()
    const sockets = new Set<net.Socket>()
    process.on('SIGTERM', () => {
        s.close()
        sockets.forEach(sock => sock.end())
    })

    s.on('connection', socket => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
        socket.on('data', d => {
            console.log('got', d.byteLength, 'bytes from', socket.remoteAddress)
            socket.write(d)
        })
    })

    await new Promise<void>((resolve, reject) => {
        s.listen(port, '0.0.0.0')
        s.once('listening', resolve)
        s.once('error', reject)
    })
}

function connectWithRetries(port: number, host: string) {
    return retryForABit(15_000, async () => {
        const socket = net.connect(port, host)
        await new Promise<void>((resolve, reject) => {
            socket.once('connect', resolve)
            socket.once('error', reject)
        })
        return socket
    })
}

// `main` is also apart of the topology. This is executable on the local machine.
export async function main() {
    console.log('\n--- bootlegBastion ---\n')
    console.log(await getServiceStatus(bootlegBastion))
    console.log('\n--- enterpriseEcho ---\n')
    console.log(await getServiceStatus(enterpriseEcho, bootlegBastion))
}
