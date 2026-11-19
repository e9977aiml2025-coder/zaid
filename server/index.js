import "dotenv/config";
import { createServer } from "node:http";
import { createApp, initScheduler } from "./app.js";

const port = Number(process.env.PORT || 3001);
const server = createServer(createApp());
server.listen(port, "0.0.0.0", () => {
  console.log(`Medisense API listening at http://localhost:${port}`);
  initScheduler();
});
