# Bootleg Bastion LTS: Lies, Tunnels & Sockets

Have you ever needed to deploy code to a machine that has no internet access? Doesn't matter. Because that's exactly what Bootleg Bastion does and you're already here. 

You can't back out now.

## The Plan

We're gonna create a new network, throw in some subnets for segmentation, and plop down 2 machines. But because we're modern developers here, the topology is already written out in code.

So 1 machine will be placed in the private subnet, 1 in the public. That public one? That's our Bootleg Bastion. 

Okay. So. How do we load them up with some logic?

Somebody once said to me "ssh is the tunnel to enlightenment, and your worst fears"

ssh it is. No fancy jump host parameter. No ProxyCommand. That's too reasonable for our Bastion. We'll scp in our ssh and ssh in our ssh in a language meant for making websites dance.

Now Bootleg Bastion can finally fulfill its life-long dream: sending a 'hello, world!' message to its sibling using TCP port 4567 every 5 seconds, to which its sibling, Enterprise Echo, will dutifully echo the message back. **Amazing.**


```
        [ Internet ]
             |
             |
       +-------------+
       |   Public    |
       |-------------|
       |   Bootleg   |
       |   Bastion   |
       +-------------+
             |
             |  (SSH tunnel / TCP 4567)
             |
       +-------------+
       |   Private   |
       |-------------|
       |  Enterprise |
       |   Echo 📡   |
       +-------------+
```

If you listen closely, you might just hear Bootleg Bastion whispering in the Ether(net)... 
<sub><sub>hello, world!</sub></sub>

## The Secret

Now for the part nobody asked for except maybe that one vaguely curious person that feels bad that no one has said anything yet: what's the stack?

There is no stack. 

I'm gonna let you in on a little secret - this ain't your Senior Frontend Engineer's favorite programming language. It just _looks_ like TypeScript. 

We're not in single process memory anymore. Well ok, ok, we kind of are, but that's to create a graph. Which executes more code. Statefully. Because Bootleg Bastion and friends would be very sad if you forgot about them.

We also invited Terraform to the party. Kind of. It's actually a fork. So not really Terraform anymore. But close enough, as every AWS resource is from a Terraform provider. 

Resource definitions are themselves resources. Instances of the definitions are... more resources. It's resources all the way down.

Maybe the real Bastion was the infrastructure we connected along the way.

<br>
<sub>Connection closed by remote host<sub>