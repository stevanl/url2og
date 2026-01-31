# URL to OG Image Service

Screenshot service for OpenGraph images with Cloudflare R2 caching.

## Features

- PNG screenshots at 1280x720 (default)
- Cloudflare R2 storage with CDN redirect
- TTL-based cache expiration (default 7 days)
- Per-URL TTL override
- Domain whitelist

## Setup

```bash
npm install
```

Create `.env`:

```
PORT=4040
R2_ACCOUNT_ID=your_account_id
R2_ACCESS_KEY=your_access_key
R2_SECRET_KEY=your_secret_key
R2_BUCKET=url2og
CDN_DOMAIN=cdn.yourdomain.com
PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
```

```bash
npm start
```

## Usage

```
# Basic
/?url=https://example.com

# Custom dimensions
/?url=https://example.com&width=1200&height=630

# Custom TTL (days) - for pages with dynamic content
/?url=https://example.com&ttl=1

# Skip cache - always regenerate
/?url=https://example.com&nocache=1
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4040` | Server port |
| `R2_ACCOUNT_ID` | - | Cloudflare account ID |
| `R2_ACCESS_KEY` | - | R2 API access key |
| `R2_SECRET_KEY` | - | R2 API secret key |
| `R2_BUCKET` | `url2og` | R2 bucket name |
| `CDN_DOMAIN` | `cdn.currencytransfer.com` | CDN domain for redirects |
| `CACHE_TTL_DAYS` | `7` | Default cache TTL in days |
| `ALLOWED_DOMAINS` | (hardcoded) | Comma-separated domain whitelist |
| `DEV_MODE` | `false` | Skip domain whitelist when `true` |
| `MAX_WIDTH` | `3000` | Maximum screenshot width |
| `MAX_HEIGHT` | `3000` | Maximum screenshot height |

## How It Works

1. Request comes in: `/?url=https://example.com`
2. Check R2 for cached image
3. If cached and not expired: 302 redirect to CDN
4. If not cached or expired: capture screenshot, upload to R2, redirect to CDN

## Local Development

```bash
DEV_MODE=true node index.js
```

This disables domain whitelist for testing with any URL.

## Deployment

See nginx and systemd config in your deployment notes. Requires:
- Node.js 22+
- Google Chrome (`google-chrome-stable`)
- Cloudflare R2 bucket with public custom domain

## License

AGPL-3.0
