# Python API security (production)

## Checklist

1. **API key (required)**  
   Set a strong `API_SECRET_KEY` and `REQUIRE_API_KEY=true`.  
   Clients must send:
   - Header: `X-API-Key: <secret>`  
   - or `Authorization: Bearer <secret>`  
   - WebSocket: `wss://host/ws/audio?api_key=<secret>`

2. **Rate limit**  
   `RATE_LIMIT_PER_MINUTE=60` (per IP). Returns HTTP `429`.

3. **CORS**  
   Set `ALLOWED_ORIGINS` to explicit domains only.  
   Empty list = no browser CORS (recommended if only Laravel calls Python).

4. **Logging**  
   Request bodies / prompts / audio / images are **not** logged.  
   Logs keep: method, path, status, sizes, mode.  
   Query `api_key` is redacted in access logs.

5. **Docs**  
   In `APP_ENV=production`, `/docs` and OpenAPI are disabled.

## Deploy note (pm2)

Update server `.env`, then:

```bash
pm2 restart mmt-python-ai
```

Laravel `PYTHON_API_KEY` must match `API_SECRET_KEY`.
