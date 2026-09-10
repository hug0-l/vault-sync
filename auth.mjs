import crypto from "crypto";
import bcrypt from "bcryptjs";
import { authenticator } from "otplib";

const sessions = new Map();
const SESSION_TTL = 12 * 3600e3;
const attempts = new Map();

export const hashPw = (p) => bcrypt.hashSync(p, 10);
export const checkPw = (p, h) => bcrypt.compareSync(p, h);

export function rateLimited(ip) {
  const a = attempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 60000) { a.n = 0; a.t = Date.now(); }
  a.n++;
  attempts.set(ip, a);
  return a.n > 5;
}

export function login(cfg, password, code) {
  if (!cfg.admin || !checkPw(password, cfg.admin.passhash)) return null;
  if (cfg.admin.totp && cfg.admin.totp.enabled) {
    if (!code || !authenticator.verify({ token: code, secret: cfg.admin.totp.secret })) return null;
  }
  const sid = crypto.randomBytes(24).toString("base64url");
  sessions.set(sid, Date.now() + SESSION_TTL);
  return sid;
}

export const valid = (sid) => !!sid && sessions.has(sid) && sessions.get(sid) > Date.now();
export const revoke = (sid) => sessions.delete(sid);

export const newTotpSecret = () => authenticator.generateSecret();
export const totpUrl = (secret, label) => authenticator.keyuri(label, "vault-sync", secret);
export const totpCheck = (secret, code) => authenticator.check(code, secret);
