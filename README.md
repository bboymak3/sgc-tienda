# SGC Tienda — Bot de Pedidos en Línea

Bot de IA para tiendas: catálogo con fotos, carrito, checkout, aprobación de pago y despacho.

## 🚀 URLs

| Servicio | URL |
|----------|-----|
| **Bot de Tienda** | https://botproducto.makeseo.app |
| **Chat público** | https://botproducto.makeseo.app/chat?t=1 |
| **Panel Admin** | https://botproducto.makeseo.app/admin |
| **Hosting** | Cloudflare Pages (Advanced Mode) |

## 🌐 Ecosistema makeseo.app

| Subdominio | Proyecto | Función |
|------------|----------|---------|
| makeseo.app | MakeSEO Academy | Academia + Landing |
| bot.makeseo.app | SGC SaaS | Bot WhatsApp citas |
| botproducto.makeseo.app | SGC Tienda (este) | Bot productos |
| flujos.makeseo.app | SGC Flujos | Motor flujos |

## 📋 Características

- Optimus Cars (tenant 37): 166 productos con fotos en R2 (`fotos.optimuscars.cl`)
- Galería con scroll horizontal
- Carrito + checkout + pago obligatorio (método + referencia)
- Bot OptimusBot (Calce Perfecto Trexon)
- Fotos bajo demanda [FOTO:] y [LISTA]
- Usado por tienda.optimuscars.cl: su chat propio "Asesor virtual · Optimus AI" (repo `tiendaoptimus`, `site/asesor.js`) llama a `POST /api/chat?t=37`

## 🤖 Cómo arma la IA el prompt (`getSystemPrompt`)

- **Catálogo en vivo:** con hasta 300 productos activos, el prompt incluye la lista completa (nombre exacto, precio y categoría) leída de D1 en cada conversación; con más, un resumen por categoría. Lo que se agrega o edita en el panel de la tienda (`tienda.optimuscars.cl/admin`, misma tabla `sgc_tie_Productos`) lo conoce el bot al instante.
- **Prompt propio del negocio (`custom_prompt`):** si trae reglas de fotos (`[FOTO:...]`), esas reglas mandan y no se agregan las genéricas que pedían `[LISTA]` siempre; se suma la instrucción de mostrar 2 a 4 productos de la categoría pedida. Sin `custom_prompt`, se usan las reglas genéricas de siempre.
- El `custom_prompt` de Optimus Cars se aplica con `tools/set-bot-prompt.mjs` del repo `tiendaoptimus` (ya no lleva el catálogo: lo pone el bot).
- Modelo por tenant: config `ai_model` (Optimus Cars: `@cf/meta/llama-3.3-70b-instruct-fp8-fast`).

## ⚙️ Config pública por tenant (`/api/config`)

`bot_enabled`, `bot_name`, `welcome_message`, `color_primario`, `moneda`, `bot_paused`, `whatsapp_enabled`, `whatsapp_number`, `whatsapp_message`, `tienda_url` y `bienvenida_productos`. Por defecto el chat (`/chat`) **solo saluda** al abrir; con `bienvenida_productos = 'true'` vuelve a listar los productos destacados en el saludo.

## 🔐 Admin

- **URL:** https://botproducto.makeseo.app/admin
- Las credenciales **no** se publican en este repositorio (es público). La sesión se firma con el secreto `JWT_SECRET` de Cloudflare Pages.

## 🛡️ Seguridad

- El chat público solo acepta mensajes `user`/`assistant` (máx. 30 mensajes de 2.000 caracteres): no se pueden inyectar mensajes `system`.
- Los precios y el total de cada `[PEDIDO]` se recalculan con los precios de la base de datos; productos que no existen quedan marcados para revisión.
- Sin endpoint de depuración público; los errores no exponen detalles internos.
- Panel `/admin`: `X-Frame-Options: DENY`, `no-store` y `noindex`.

## 🖼️ Fotos y enlaces a la tienda

- `[FOTO:nombre]` y `[LISTA]` se muestran en el chat como tarjetas con foto, precio, botón Agregar y **Ver en la tienda**.
- El enlace a la ficha sale de la config pública `tienda_url` del tenant + el `sku` del producto: `tienda_url/producto/<sku>/` (Optimus Cars, tenant 37: `https://tienda.optimuscars.cl`).

---
**SGC Tienda · makeseo.app · Edward Valencia · @makeseo**
