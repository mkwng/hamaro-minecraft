#!/usr/bin/env node
// Sets (or rotates) the admin password for the control website.
//   node scripts/set-admin-password.mjs [--region us-west-2] [password]
// With no password argument, generates a strong one and prints it ONCE.
// Stores only the scrypt hash in SSM: /hamaro/admin-password-hash.
// Also creates the session-signing key (/hamaro/session-key) if missing.
import { scryptSync, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const ri = args.indexOf("--region");
const region = ri >= 0 ? args.splice(ri, 2)[1] : "us-west-2";
const password = args[0] || randomBytes(18).toString("base64url");

const N = 16384, r = 8, p = 1;
const salt = randomBytes(16);
const hash = scryptSync(password, salt, 32, { N, r, p });
const stored = `scrypt:${N}:${r}:${p}:${salt.toString("base64url")}:${hash.toString("base64url")}`;

const aws = (a) => execFileSync("aws", ["--region", region, ...a], { encoding: "utf8" });

aws(["ssm", "put-parameter", "--name", "/hamaro/admin-password-hash",
  "--type", "SecureString", "--value", stored, "--overwrite"]);

try {
  aws(["ssm", "get-parameter", "--name", "/hamaro/session-key"]);
} catch {
  aws(["ssm", "put-parameter", "--name", "/hamaro/session-key",
    "--type", "SecureString", "--value", randomBytes(32).toString("base64url")]);
}

console.log("Admin password set. Existing admin sessions stay valid until they expire (24 h).");
if (!args[0]) console.log("\nGenerated password (save it in your password manager NOW):\n\n  " + password + "\n");
