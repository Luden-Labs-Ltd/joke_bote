import { randomBytes, scryptSync } from "node:crypto";

let password = "";
for await (const chunk of process.stdin) password += chunk;
password = password.trimEnd();
if (!password) {
  console.error("Pipe the admin password to stdin.");
  process.exitCode = 1;
} else {
  const salt = randomBytes(16);
  console.log(`${salt.toString("hex")}:${scryptSync(password, salt, 64).toString("hex")}`);
}
