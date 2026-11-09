# 🚀 GUÍA DE DESPLIEGUE — Addons en la nube para TV Box

## Qué necesito de ti (checklist)

1. **Un VPS con Docker** (elige una):
   - **Oracle Cloud Free Tier** — GRATIS para siempre (ARM 4 CPU / 24GB RAM) ✅ recomendado
   - **Hetzner CX22** — ~4€/mes (2 vCPU / 4GB)
   - Cualquier otro (DigitalOcean, Vultr, Contabo…) con Docker instalado
2. **Acceso SSH** al VPS: IP + usuario + contraseña o llave
3. **Un dominio** (cualquiera que controles) — para el HTTPS obligatorio de Stremio Android/TV Box
   - Sin dominio: subdominio gratis en DuckDNS (te explico en el paso 2)
4. **5 minutos** para los DNS

> ❗ Stremio en TV Box **exige HTTPS con certificado válido** — por eso el dominio + Caddy (Let's Encrypt automático).

## Pasos (yo ejecuto del 3 al 8 si me das acceso SSH)

### 1. DNS (tú, 2 min)
Crea 2 registros A apuntando a la IP del VPS:
- `p.tudominio.com` → IP-del-VPS  (addon Prowlarr)
- `s.tudominio.com` → IP-del-VPS  (addon Sitios)

### 2. Subir el proyecto al VPS (tú o yo por SSH)
```bash
scp -r VISOR/ root@IP-VPS:/opt/hybrid/
```

### 3. Arrancar el stack (VPS)
```bash
cd /opt/hybrid
cp .env.deploy.example .env.deploy   # editar DOMINIO
docker compose up -d --build
```

### 4. API key de Prowlarr (VPS, una vez)
```bash
docker compose exec prowlarr cat /config/config.xml | grep ApiKey
# → pegarla en .env.deploy (PROWLARR_API_KEY) y:
docker compose up -d --force-recreate hybrid-prowlarr
```

### 5. Re-registrar los 14 indexers (yo lo hago vía API en 1 minuto)
Con FlareSolverr ya en la misma red, los indexers con Cloudflare
(1337x, EZTV…) se activan aquí mejor que en tu Mac.

### 6. Verificación
```bash
curl https://p.tudominio.com/manifest.json
curl https://s.tudominio.com/manifest.json
```

### 7. En la TV Box (Stremio Android)
- Ajustes → Addons → Comunidad → URL:
  - `https://p.tudominio.com/manifest.json`  (Prowlarr [Torrents])
  - `https://s.tudominio.com/manifest.json`  (Sitios [Web + Torrents])

### 8. (Opcional, recomendado) Privacidad
Aleatorio en la ruta para que nadie más use tu ancho de banda:
`https://s.tudominio.com/TU-SECRETO/manifest.json` — lo activo con 1 línea.

## Notas técnicas
- **Caché persistente** en volumen Docker (sobrevive a reinicios)
- **Prowlarr y FlareSolverr** corren dentro del mismo stack (red interna)
- Los sitios latinos desde IP de datacenter pueden sufrir más bloqueos que
  tu IP de casa — FlareSolverr lo mitiga; si algún canal falla, es la IP
  del VPS, no el código.
- Tu Mac queda libre: nada corre en local.
