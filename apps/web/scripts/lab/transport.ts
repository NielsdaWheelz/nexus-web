/** Owned loopback TCP transport. TLS and HTTP/2 pass through unchanged. Cutting
 * reachability closes pooled connections and rejects new ones; storage is separate. */
import { connect, createServer, type Socket } from "node:net";

export async function openLabWebTransport(targetPort: number): Promise<{
  port: number; setReachable(reachable: boolean): void; close(): Promise<void>;
}> {
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535)
    throw new Error("lab web transport requires a valid loopback port");
  let reachable = true;
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, client => {
    if (!reachable) { client.destroy(); return; }
    const upstream = connect({ host: "127.0.0.1", port: targetPort, allowHalfOpen: true });
    const pairs: [Socket, Socket][] = [[client, upstream], [upstream, client]];
    for (const [socket, peer] of pairs) {
      sockets.add(socket);
      socket.on("error", () => peer.destroy());
      socket.on("close", () => { sockets.delete(socket); if (!socket.readableEnded) peer.destroy(); });
    }
    client.pipe(upstream); upstream.pipe(client);
  });
  const setReachable = (next: boolean) => {
    reachable = next;
    if (!next) for (const socket of sockets) socket.destroy();
  };
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("lab web transport did not publish a port");
  return { port: address.port, setReachable, close: async () => {
    setReachable(false);
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
