import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const publicDir = path.join(rootDir, "public");

// Load .env file
const envPath = path.join(rootDir, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !process.env[match[1].trim()]) {
      process.env[match[1].trim()] = match[2].trim();
    }
  }
}

const apiTarget =
  process.env.VITE_API_PROXY_TARGET || "https://yt-dl.stanleyowen.com";

if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

const redirects = `# Proxy API requests to backend server
/api/*  ${apiTarget}/api/:splat  200

# SPA fallback - serve index.html for all other routes
/*  /index.html  200
`;

fs.writeFileSync(path.join(publicDir, "_redirects"), redirects);
console.log(`Generated _redirects with API target: ${apiTarget}`);
