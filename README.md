# WA5

**Hasta cinco cuentas de WhatsApp Web al mismo tiempo, en una sola app de macOS.**

Cada cuenta corre en su propia sesión de Chromium —cookies, `localStorage` e `IndexedDB`
separados— así que ningún número ve ni pisa la sesión de otro. Cambias de cuenta con un
clic o con `⌘1` … `⌘5`.

> Proyecto independiente. No está afiliado, patrocinado ni respaldado por WhatsApp LLC ni
> por Meta Platforms, Inc. «WhatsApp» es una marca registrada de sus titulares.

![WA5 con cuatro cuentas en la barra lateral](docs/captura.png)

---

## Qué hace

- **Cinco cuentas simultáneas**, cada una con login independiente y persistente.
- **Aislamiento real de sesión**: cada cuenta vive en una partición `persist:wa-<id>`
  distinta. Nada de perfiles de navegador ni ventanas sueltas.
- **Cambio instantáneo** desde la barra lateral o con `⌘1` … `⌘5`.
- **Contador de no leídos** por cuenta y suma total en el badge del Dock.
- **Notificación nativa** cuando entra un mensaje a una cuenta que no está a la vista.
- **Cerrar sesión** o **eliminar** una cuenta borrando de verdad sus datos locales.
- **Zoom independiente** por cuenta (`⌘+`, `⌘-`, `⌘0`).
- **La ventana recuerda** tamaño y posición entre arranques.
- Cero telemetría: WA5 no manda nada a ningún servidor. Todo vive en tu Mac.

## Lo que no hace

- No crea cuentas de WhatsApp: usas números que ya tienes.
- No evade las reglas de WhatsApp; la app carga `web.whatsapp.com` tal cual.
- No funciona sin internet ni sin el teléfono vinculado, igual que WhatsApp Web.

## Instalar

Requiere macOS 11 o superior y Node 18 o superior.

```bash
git clone https://github.com/waltgarcia/wa5.git
cd wa5
npm install
npm start
```

### Generar el .app

```bash
npm run empaquetar      # deja dist/WA5-darwin-arm64/WA5.app
cp -R dist/WA5-darwin-arm64/WA5.app /Applications/
```

La primera vez que abras el `.app` sin firma, macOS pedirá confirmación:
clic derecho sobre el ícono → **Abrir**.

## Uso

1. Abre la app. Se crea sola la cuenta **Personal** con su código QR.
2. En el teléfono: WhatsApp → **Dispositivos vinculados** → *Vincular un dispositivo*.
3. Escanea el QR. Repite con el **+** de la barra lateral para cada cuenta nueva.
4. Clic derecho sobre un círculo de la barra: renombrar, recargar, cerrar sesión,
   zoom o eliminar cuenta.

| Atajo | Acción |
|---|---|
| `⌘1` … `⌘5` | Ir a la cuenta 1–5 |
| `⌘⇧N` | Agregar cuenta |
| `⌘R` | Recargar la cuenta activa |
| `⌘+` / `⌘-` / `⌘0` | Zoom de la cuenta activa |

## Cómo funciona

```
main.js                  proceso principal: ventana, cuentas y sesiones
 ├─ BrowserWindow        dibuja solo la barra lateral (renderer/)
 ├─ WebContentsView ×N   una vista web por cuenta, aislada por partición
 └─ session.fromPartition('persist:wa-<id>')   cookies + storage por número
preload.js               puente IPC con contextIsolation (sin nodeIntegration)
renderer/                barra lateral: círculos, badges y menú contextual
```

Las cuentas se guardan en `~/Library/Application Support/WA5/cuentas.json`.
Los datos de sesión de cada cuenta quedan en `~/Library/Application Support/WA5/Partitions/wa-<id>/`.
Borrar ese directorio equivale a cerrar sesión en todas las cuentas.

## Por qué no un navegador con perfiles

Funciona, pero son ventanas sueltas sin barra común, sin badge unificado y con un
`user-data-dir` por cuenta que hay que administrar a mano. WA5 junta todo en una
ventana y usa las particiones de sesión de Electron, que es el mecanismo que el propio
Chromium usa para aislar perfiles.

## Estado

macOS, Apple Silicon e Intel. En Linux y Windows debería funcionar sin cambios, pero no
está probado; los PR son bienvenidos.

## Licencia

MIT — ver [LICENSE](LICENSE).
