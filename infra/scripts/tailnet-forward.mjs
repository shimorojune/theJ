// Dev only. Docker Desktop containers can't route to Tailscale 100.x addresses on macOS, so this
// forwards localhost:11080 to the home proxy. Containers then use host.docker.internal:11080.
// Usage: node infra/scripts/tailnet-forward.mjs [target-host] [target-port]
import net from "node:net";

const [host = "100.104.87.114", port = "1080"] = process.argv.slice(2);
net
  .createServer((client) => {
    const upstream = net.connect(Number(port), host);
    client.pipe(upstream).pipe(client);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close);
    upstream.on("error", close);
  })
  .listen(11080, "127.0.0.1", () => console.log(`forwarding 127.0.0.1:11080 -> ${host}:${port}`));
