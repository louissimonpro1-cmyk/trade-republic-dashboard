import { clearCookie } from "../lib/auth.mjs";

export default function handler(req, res) {
  const secure = (req.headers["x-forwarded-proto"] || "").includes("https");
  res.statusCode = 302;
  res.setHeader("Set-Cookie", clearCookie(secure));
  res.setHeader("Location", "/login.html");
  res.end();
}
