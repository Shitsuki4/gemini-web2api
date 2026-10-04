import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
await mkdir(".local", { recursive: true });
const secrets = {
  ADMIN_KEY: "admin_" + randomBytes(32).toString("hex"),
  API_KEY: "sk-" + randomBytes(32).toString("hex"),
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
};
await writeFile(".local/secrets.json", JSON.stringify(secrets, null, 2), {
  flag: "wx",
  mode: 0o600,
});
console.log(
  "Created .local/secrets.json. Keep private; existing keys are never overwritten.",
);
