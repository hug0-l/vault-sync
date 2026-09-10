import fs from "fs";
import path from "path";
import crypto from "crypto";

const DATA = process.env.DATA_DIR || "/data";
const ENCFILE = path.join(DATA, "config.enc");

export function keyMaterial() {
  const kf = process.env.KEY_FILE || "/run/secrets/key";
  if (fs.existsSync(kf)) return { buf: fs.readFileSync(kf), fromUSB: true };
  const local = path.join(DATA, ".fallback-key");
  if (!fs.existsSync(local)) fs.writeFileSync(local, crypto.randomBytes(32).toString("base64"), { mode: 0o600 });
  return { buf: fs.readFileSync(local), fromUSB: false };
}

const derive = (mat, salt) => crypto.scryptSync(mat.buf, salt, 32);

export function loadConfig() {
  if (!fs.existsSync(ENCFILE)) return null;
  const env = JSON.parse(fs.readFileSync(ENCFILE, "utf8"));
  if (env.v !== 1) throw new Error("unknown config envelope version");
  const salt = Buffer.from(env.salt, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", derive(keyMaterial(), salt), Buffer.from(env.iv, "base64"));
  d.setAuthTag(Buffer.from(env.tag, "base64"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(env.data, "base64")), d.final()]).toString("utf8"));
}

export function saveConfig(cfg) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const e = crypto.createCipheriv("aes-256-gcm", derive(keyMaterial(), salt), iv);
  const data = Buffer.concat([e.update(JSON.stringify(cfg), "utf8"), e.final()]);
  const env = { v: 1, salt: salt.toString("base64"), iv: iv.toString("base64"), tag: e.getAuthTag().toString("base64"), data: data.toString("base64") };
  fs.writeFileSync(ENCFILE + ".tmp", JSON.stringify(env), { mode: 0o600 });
  fs.renameSync(ENCFILE + ".tmp", ENCFILE);
}

export const newSecret = (n = 18) => crypto.randomBytes(n).toString("base64");
