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
- Integrado en tienda.optimuscars.cl (botón Asistente Optimus)

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
