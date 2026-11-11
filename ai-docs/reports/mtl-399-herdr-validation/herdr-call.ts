// One herdr socket call against the check session: bun herdr-call.ts <method> '<params json>'
import { HerdrSocket } from "../../../../packages/cli/src/herdr/herdr-socket.ts";

const sock = new HerdrSocket("/Users/jack/.config/herdr/sessions/claudish-mtl399-check/herdr.sock");
try {
  console.log(JSON.stringify(await sock.request(process.argv[2], JSON.parse(process.argv[3] ?? "{}"))));
} catch (e) {
  console.log(`ERROR ${(e as Error).constructor.name} ${(e as Error).message}`);
}
sock.close();
