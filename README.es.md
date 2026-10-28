# osu-render

[English](README.md) · [繁體中文](README.zh-TW.md) · **Español**

Servicio autoalojado que convierte replays de osu! (`.osr`) en videos MP4 usando
[danser-go](https://github.com/Wieku/danser-go). Arrastras un replay a la página web: el servicio busca el mapa
con la API de osu!, lo descarga de un mirror, lo renderiza con danser y te entrega un MP4 de 720p o 1080p a
60 FPS. La codificación de video usa tu GPU (NVIDIA NVENC, AMD AMF o Intel Quick Sync) cuando puede y la CPU
(x264) cuando no.

> **El soporte para Windows y NVIDIA/AMD es nuevo y necesita testers.** Si tienes uno de esos equipos, ejecutar
> `npm run doctor` y enviar el reporte ayuda muchísimo. Consulta [Diagnóstico y reportes](#diagnóstico-y-reportes).

## Contenido

- [Funciones](#funciones)
- [Plataformas y GPU](#plataformas-y-gpu)
- [Requisitos](#requisitos)
- [Aplicación OAuth de osu!](#aplicación-oauth-de-osu)
- [Inicio rápido: Windows](#inicio-rápido-windows)
- [Inicio rápido: Linux](#inicio-rápido-linux)
- [Configuración](#configuración)
- [Cómo se elige el codificador](#cómo-se-elige-el-codificador)
- [Diagnóstico y reportes](#diagnóstico-y-reportes)
- [API HTTP](#api-http)
- [Notas de seguridad](#notas-de-seguridad)
- [Solución de problemas](#solución-de-problemas)
- [Desarrollo](#desarrollo)
- [Licencia y créditos](#licencia-y-créditos)

## Funciones

- Interfaz web con arrastrar y soltar, en English, 繁體中文 y Español.
- Solo subes el replay. El mapa se busca por su checksum con la API de osu!, se descarga de mirrors
  configurables (si uno falla se prueba el siguiente) y se verifica contra el MD5 del replay antes de renderizar.
- 720p o 1080p a 60 FPS, video H.264 con audio AAC.
- Opciones visuales por render: saltar la intro, volúmenes, atenuación/desenfoque/paralaje del fondo, bloom,
  escala del área de juego, tamaño/estela/efectos del cursor, colores de la skin o del mapa, elementos del HUD y
  detalles de los objetos.
- Detección automática del codificador por GPU con una prueba real de un fotograma; si falla, usa x264.
- Cola FIFO persistente (SQLite), un render a la vez, recuperación tras un cierre inesperado o reinicio.
- Protección de disco: rechaza renders si queda poco espacio; videos y replays caducan a las 24 horas y los mapas
  en caché se borran empezando por los menos usados.
- API HTTP sencilla con descargas por rangos (`Range`) y token bearer opcional.
- Reporte de diagnóstico integrado (`npm run doctor` o la interfaz web) para reportar problemas.

## Plataformas y GPU

| Plataforma | Codificador | Estado |
| --- | --- | --- |
| Linux | Intel Quick Sync (`h264_qsv`) | Verificado |
| Linux | NVIDIA NVENC (`h264_nvenc`) | Implementado, necesita testers |
| Linux | AMD AMF (`h264_amf`) | Experimental: requiere el runtime AMF propietario de AMD; la mayoría de los equipos usarán x264 |
| Windows 10 / 11 | NVIDIA NVENC (`h264_nvenc`) | Implementado, necesita testers |
| Windows 10 / 11 | AMD AMF (`h264_amf`) | Implementado, necesita testers |
| Windows 10 / 11 | Intel Quick Sync (`h264_qsv`) | Implementado, necesita testers |
| Cualquiera | CPU x264 (`libx264`) | Respaldo, siempre disponible (más lento) |
| macOS | — | No soportado |

Las variantes HEVC (`hevc_nvenc`, `hevc_amf`, `hevc_qsv`) se pueden forzar con `RENDER_ENCODER`.

## Requisitos

- **Node.js 22.12 o superior** (se recomienda la LTS actual). En Windows usa la versión de 64 bits.
- **danser-go 0.11 o superior, se recomienda 0.12.1.** Descarga el zip para tu sistema desde las
  [releases de danser-go](https://github.com/Wieku/danser-go/releases). Ya incluye el FFmpeg que usa danser, así
  que no necesitas instalar FFmpeg aparte.
- **Una aplicación OAuth de osu!** (client ID y secret), ver [más abajo](#aplicación-oauth-de-osu).
- **Un controlador (driver) de GPU** si quieres codificación por hardware:
  - NVIDIA: un driver GeForce/Studio reciente. Con drivers viejos la prueba de NVENC falla con
    `Driver does not support the required nvenc API version`.
  - AMD: en Windows, el driver Adrenalin (incluye el runtime AMF). En Linux, AMF necesita el runtime propietario
    de AMD, que la mayoría de las distribuciones no incluye.
  - Intel: el driver de gráficos de Intel, y la GPU integrada debe estar activada. En PCs de escritorio con tarjeta
    gráfica dedicada, la iGPU suele estar desactivada en la BIOS/UEFI (busca "iGPU Multi-Monitor" o similar).
    En Linux, Quick Sync también necesita `intel-media-driver` y el runtime oneVPL para GPU (`vpl-gpu-rt`, llamado
    `libmfx-gen1` / `onevpl-intel-gpu` en algunas distribuciones).
- **Espacio en disco:** deja al menos 15 GiB libres. Por debajo de 8 GiB se rechazan renders nuevos.

## Aplicación OAuth de osu!

El servicio usa el flujo **client credentials** de la API v2 de osu!: solo lee datos públicos de mapas y nunca
inicia sesión con ninguna cuenta.

1. Abre <https://osu.ppy.sh/home/account/edit>, baja hasta **OAuth** y haz clic en **New OAuth Application**.
2. Ponle cualquier nombre. El campo **Application Callback URL** puede quedar vacío. Si el formulario lo exige,
   usa `http://127.0.0.1:3030/` (nunca se llama).
3. Copia el **Client ID** y el **Client Secret** en `.env` como `OSU_CLIENT_ID` y `OSU_CLIENT_SECRET`.
   El secret se queda en el servidor y nunca llega al navegador. No lo compartas.

## Inicio rápido: Windows

> [!IMPORTANT]
> Ejecuta el servicio **dentro de tu sesión de escritorio de Windows con tu usuario iniciado** (una ventana de
> terminal normal, o una tarea del Programador de tareas que solo se ejecute cuando hayas iniciado sesión).
> **No funciona** como servicio de Windows, con "Ejecutar tanto si el usuario inició sesión como si no" ni por SSH:
> eso corre en la sesión 0 o en una sesión no interactiva, donde solo existe el driver GDI Generic OpenGL 1.1, y
> danser necesita OpenGL 3.3 del driver de tu GPU.

1. Instala [Node.js LTS](https://nodejs.org/) y [Git](https://git-scm.com/) (o usa **Code → Download ZIP** en
   GitHub en lugar de `git clone`). En PowerShell:

   ```powershell
   winget install OpenJS.NodeJS.LTS
   winget install Git.Git
   ```

   Después abre una ventana nueva de PowerShell para que `node` y `npm` estén en el `PATH`.

2. Descarga `danser-0.12.1-win.zip` desde las [releases de danser-go](https://github.com/Wieku/danser-go/releases)
   y extráelo, por ejemplo en `C:\danser` (debe existir `C:\danser\danser-cli.exe`).
   SmartScreen o Defender pueden advertir sobre el exe sin firmar, ver [Solución de problemas](#solución-de-problemas).

3. Descarga el código y crea tu configuración:

   ```powershell
   git clone https://github.com/956zs/osu-render.git
   cd osu-render
   Copy-Item .env.example .env
   notepad .env
   ```

   Configura al menos:

   ```ini
   DANSER_DIR=C:/danser
   OSU_CLIENT_ID=12345
   OSU_CLIENT_SECRET=tu-secret
   ```

   Sirven barras normales (`C:/danser`) o barras invertidas simples (`C:\danser`). No uses comillas.

4. Instala, compila, revisa e inicia:

   ```powershell
   npm ci
   npm run build
   npm run doctor
   npm start
   ```

   `npm run doctor` muestra lo que encontró (danser, FFmpeg, GPUs, qué codificadores pasan la prueba) y guarda un
   reporte, ver [Diagnóstico y reportes](#diagnóstico-y-reportes).

5. Abre <http://127.0.0.1:3030/> y arrastra un replay. Deja la terminal abierta mientras el servicio esté en uso.

**Opcional: iniciar automáticamente al iniciar sesión.** El Programador de tareas puede ejecutar `npm start` al
iniciar sesión. En PowerShell, desde la carpeta del repositorio:

```powershell
$action   = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c npm start" -WorkingDirectory (Get-Location).Path
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "osu-render" -Action $action -Trigger $trigger -Settings $settings
```

Esto registra una tarea que solo se ejecuta mientras tienes la sesión iniciada, que es lo que danser necesita.
No la cambies a "Ejecutar tanto si el usuario inició sesión como si no". Para quitarla:
`Unregister-ScheduledTask -TaskName osu-render`.

## Inicio rápido: Linux

```sh
# 1. danser (el zip no trae permisos de ejecución, hay que darlos)
mkdir -p ~/danser
unzip danser-0.12.1-linux.zip -d ~/danser
chmod +x ~/danser/danser ~/danser/danser-cli ~/danser/ffmpeg/bin/ffmpeg ~/danser/ffmpeg/bin/ffprobe
# danser 0.11 usa una estructura plana: chmod +x ~/danser/danser-cli ~/danser/ffmpeg/ffmpeg ~/danser/ffmpeg/ffprobe

# 2. el servicio
git clone https://github.com/956zs/osu-render.git ~/osu-render
cd ~/osu-render
cp .env.example .env
$EDITOR .env        # DANSER_DIR=<salida de: echo ~/danser>, OSU_CLIENT_ID, OSU_CLIENT_SECRET
npm ci
npm run build
npm run doctor
npm start           # luego abre http://127.0.0.1:3030/
```

El servicio encuentra solo las bibliotecas de FFmpeg que trae danser (`ffmpeg/lib` en 0.12, `ffmpeg/` en 0.11);
no hace falta configurar `LD_LIBRARY_PATH`.

**Pantalla:** danser 0.12+ renderiza fuera de pantalla (offscreen) en Linux y no necesita display, así que
también funciona en un servidor sin monitor. danser 0.11 abre una ventana oculta y necesita `DISPLAY` o
`WAYLAND_DISPLAY` de una sesión gráfica activa.

**systemd --user:** [`systemd/osu-render.service`](systemd/osu-render.service) es una unidad de ejemplo que
espera el repositorio en `~/osu-render` y danser en `~/danser`. Ajusta las rutas (y la de `node`) y luego:

```sh
mkdir -p ~/.config/systemd/user
cp systemd/osu-render.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now osu-render.service
journalctl --user -u osu-render.service -f
```

Para que siga corriendo después de cerrar sesión, activa lingering: `loginctl enable-linger "$USER"` (sirve con
danser 0.12+; danser 0.11 necesita la sesión de escritorio de todos modos).

## Configuración

La configuración se lee de `.env` en la raíz del repositorio. Las variables que ya existen en el entorno real
tienen prioridad sobre `.env`. Las rutas pueden ser absolutas o relativas a la raíz del repositorio.

| Variable | Valor por defecto | Descripción |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Dirección donde escucha. Lee las [notas de seguridad](#notas-de-seguridad) antes de cambiarla. |
| `PORT` | `3030` | Puerto HTTP. |
| `DATA_DIR` | `./data` | Base de datos, replays, videos, mapas, logs y reportes de diagnóstico. |
| `DANSER_DIR` | `./danser` | Carpeta donde extrajiste danser. |
| `DANSER_BIN` | `<DANSER_DIR>/danser-cli` (`.exe` en Windows) | Ejecutable CLI de danser, si está en otro lugar. |
| `DANSER_BASE_SETTINGS` | `<DANSER_DIR>/settings/default.json` | Configuración de danser que se usa como base para los renders (ver abajo). |
| `DANSER_SKINS_DIR` | `<DATA_DIR>/skins` | Carpeta de skins que se pasa a danser. |
| `DANSER_SETTINGS_NAME` | `service` | Nombre del archivo de configuración que escribe el servicio: `<DANSER_DIR>/settings/<name>.json`. Solo letras, dígitos, `-` y `_`. |
| `RENDER_ENCODER` | `auto` | `auto`, `h264_nvenc`, `hevc_nvenc`, `h264_amf`, `hevc_amf`, `h264_qsv`, `hevc_qsv` o `libx264`. Cualquier otro valor detiene el arranque con un error. |
| `OSU_CLIENT_ID` | vacío | Client ID de OAuth de osu!. Obligatorio. |
| `OSU_CLIENT_SECRET` | vacío | Client secret de OAuth de osu!. Obligatorio. |
| `BEATMAP_MIRRORS` | `https://mirror.hinamizawa.ai/api/v1/hinai/d/{id}` | URLs de descarga de `.osz` separadas por comas, en orden. `{id}` es el ID del beatmapset. |
| `AUTH_TOKEN` | vacío | Si se define, cada petición a `/api/*` necesita `Authorization: Bearer <token>`. |
| `MAX_QUEUE` | `20` | Máximo de trabajos sin terminar. |

**Configuración base de danser.** El servicio copia `DANSER_BASE_SETTINGS`, sobrescribe lo necesario (carpetas,
60 FPS, codificador, salida) y guarda el resultado en `<DANSER_DIR>/settings/<DANSER_SETTINGS_NAME>.json`. Si el
archivo base no existe, se usan los valores por defecto de danser. Si quieres un archivo base para ajustarlo
(skin, cursor, etc.), ejecuta una vez `danser-cli -noupdatecheck` en la carpeta de danser: crea
`settings/default.json`, muestra `No beatmap specified, closing...` y se cierra.

Los parámetros ajustables que no son secretos están en [`config/defaults.json`](config/defaults.json): el orden
automático de codificadores por plataforma, el tamaño y el tiempo límite de la prueba, los tamaños del
diagnóstico y el enlace para issues. Para cambiarlos, crea `config/local.json` solo con las claves que quieras
sobrescribir; se combina sobre los valores por defecto y git lo ignora. Ejemplo:

```json
{ "encoders": { "autoOrder": { "win32": ["h264_qsv", "libx264"] } } }
```

## Cómo se elige el codificador

danser solo comprueba que el nombre del codificador exista en FFmpeg; si la GPU o el driver no pueden usarlo de
verdad, el render falla a la mitad. Por eso, al arrancar, el servicio **codifica un fotograma negro de 240×144**
con el FFmpeg de danser para cada candidato y se queda con el primero que funciona:

| `RENDER_ENCODER` | Candidatos, en orden |
| --- | --- |
| `auto` en Windows | `h264_nvenc` → `h264_amf` → `h264_qsv` → `libx264` |
| `auto` en Linux | `h264_nvenc` → `h264_qsv` → `h264_amf` → `libx264` |
| un codificador concreto | ese codificador → `libx264` |

Si termina usando `libx264`, los renders siguen funcionando, pero `/health` indica `"status": "degraded"` con
`"reason": "hardware_encoder_unavailable"` (modo auto) o `"encoder_unavailable"` (falló el codificador que
forzaste). Mientras esté degradado, la comprobación se repite de vez en cuando (en peticiones a `/health` y en
renders nuevos), así que una GPU que esté disponible más tarde se detecta sin reiniciar.

## Diagnóstico y reportes

Si algo no funciona, o simplemente quieres ayudar a probar, envía un reporte de diagnóstico:

1. **`npm run doctor`** muestra un resumen y guarda `data/diagnostics/doctor-<timestamp>.json`.
   `npm run doctor -- --json` imprime el JSON en lugar del resumen. El doctor prueba **todos** los
   codificadores soportados, no solo el primero que funciona, así que un solo reporte muestra el panorama completo
   de NVENC / AMF / QSV / x264.
2. **En la interfaz web**, la tarjeta **Diagnóstico** tiene **Descargar reporte** (el mismo JSON), **Copiar
   resumen** (texto corto para un chat) y **Abrir issue en GitHub** (un formulario de issue ya rellenado).
   `GET /api/diagnostics` también devuelve el JSON.
3. **Abre un issue** con la plantilla [GPU / platform report](https://github.com/956zs/osu-render/issues/new?template=gpu-report.yml)
   y pega el JSON. También puedes enviarle el archivo directamente al mantenedor.

### Privacidad

- **Incluye:** nombre, versión y arquitectura del sistema operativo, modelo de CPU, número de núcleos, cantidad de
  RAM, nombres, fabricantes y versiones de driver de las GPUs, versiones de danser y FFmpeg y la lista de
  codificadores de FFmpeg, resultados de las pruebas de codificadores (con el final de la salida de error de
  FFmpeg), el resultado de la comprobación de arranque, un resumen de la configuración (host, puerto, codificador
  configurado, nombres de host de los mirrors, y solo *si* las credenciales OAuth y `AUTH_TOKEN` están definidos),
  espacio libre en disco, y metadatos de los últimos 20 renders (estado, codificador, resolución, tiempos, código
  de error y un fragmento final del log de danser, que puede mencionar títulos de mapas), y un resumen del `danser.log` de danser
  (versiones, GPU usada para OpenGL).
- **No incluye:** el client ID y el secret de OAuth, `AUTH_TOKEN`, direcciones IP, nombres de jugadores ni
  archivos de replays o mapas. Tu carpeta personal se reemplaza por `~` y tu nombre de usuario por `<user>`.
- **No se envía nada automáticamente.** El servicio nunca sube nada; tú decides si compartes el archivo. El
  botón **Abrir issue en GitHub** solo abre en tu navegador una página ya rellenada (ese texto viaja a github.com en
  la dirección de la página); no se publica nada hasta que presiones **Submit**. Los issues de GitHub son públicos,
  así que revisa el reporte antes de publicarlo.

## API HTTP

Si `AUTH_TOKEN` está definido, agrega `-H "Authorization: Bearer $AUTH_TOKEN"` a cada llamada a `/api/*`.

| Método y ruta | Descripción |
| --- | --- |
| `POST /api/renders` | Subida multipart: `replay` (el `.osr`, máx. 5 MiB) y `options` opcional (texto JSON). Devuelve `{ "id", "status" }`. |
| `GET /api/renders/:id` | Estado del trabajo, progreso, posición en la cola, mapa, formato de salida y error. |
| `GET /api/renders/:id/video` | El MP4 terminado. Soporta HTTP `Range`. |
| `DELETE /api/renders/:id` | Cancela un trabajo. |
| `GET /api/diagnostics` | Reporte de diagnóstico (el mismo JSON que `npm run doctor`). |
| `GET /health` | Estado del servicio (sin autenticación): `status`, `renderer`, `display`, `encoder`, `encoderKind`, `platform`, `queue`, `freeDiskBytes`, `reason`. |

```sh
curl -F replay=@my-play.osr -F 'options={"resolution":"720p","skipIntro":true}' http://127.0.0.1:3030/api/renders
curl http://127.0.0.1:3030/api/renders/<id>
curl -o my-play.mp4 http://127.0.0.1:3030/api/renders/<id>/video
```

Estados del trabajo: `uploaded` → `resolving` → `downloading` → `queued` → `rendering` → `finalizing` →
`completed`, o `failed` / `cancelled`. Límites: solo replays de osu!standard, mapas de hasta 15 minutos,
30 minutos por render, 5 subidas por minuto y 3 trabajos sin terminar por cliente.

## Notas de seguridad

- Por defecto el servicio escucha en `127.0.0.1`, así que solo tu propio equipo puede conectarse.
- **Define `AUTH_TOKEN` antes de exponerlo** (`HOST=0.0.0.0`, reenvío de puertos o un reverse proxy). El token
  protege `/api/*`; la página web tiene un campo para ingresarlo. Usa HTTPS (con un reverse proxy) si el token
  pasa por una red en la que no confías.
- El navegador no puede pasar argumentos arbitrarios a danser o FFmpeg ni rutas de archivos. Las opciones de
  render se validan contra una lista permitida y se convierten en un conjunto fijo de parámetros y parches de
  configuración de danser.
- Los `.osz` descargados se extraen con precaución: límites de cantidad de entradas y tamaño total, sin rutas
  absolutas, `..`, symlinks u otros archivos especiales, sin nombres reservados de Windows (`CON`, `NUL`,
  `COM1`…) ni duplicados que solo difieren en mayúsculas, y el `.osu` debe coincidir con el MD5 del mapa del
  replay.
- El secret de OAuth y `AUTH_TOKEN` se quedan en `.env` (ignorado por git) y nunca se envían al navegador ni
  aparecen en los reportes de diagnóstico.

## Solución de problemas

**`/health` aparece como degraded.** El campo `reason` indica por qué:

| Motivo | Significado / qué hacer |
| --- | --- |
| `renderer_unavailable` | No se encontró danser-cli. Revisa `DANSER_DIR` / `DANSER_BIN`; en Linux ejecuta `chmod +x`. |
| `display_unavailable` | Linux con danser 0.11 y sin `DISPLAY` / `WAYLAND_DISPLAY`. Inícialo desde tu sesión de escritorio o usa danser 0.12+. |
| `hardware_encoder_unavailable` | Ningún codificador de GPU pasó la prueba; se renderiza con la CPU (más lento). Ver abajo. |
| `encoder_unavailable` | Falló el codificador definido en `RENDER_ENCODER` (se usa x264 si funciona), o no funciona ningún codificador. |
| `storage_low` | Quedan menos de 8 GiB libres en `DATA_DIR`. |

**Un codificador de GPU falla la prueba.** Ejecuta `npm run doctor` y mira `encoderProbes[].error`:

- NVIDIA: `Driver does not support the required nvenc API version` o `No capable devices found` significa que el
  driver es demasiado viejo o que la GPU NVIDIA no está activa (laptops: conecta el cargador y revisa que la GPU no
  esté desactivada). Actualiza el driver.
- AMD: errores de `amfrt64.dll` o de AMF significan que falta el driver Adrenalin o está desactualizado.
- Intel: los errores de sesión QSV / MFX suelen indicar que la iGPU está desactivada en la BIOS/UEFI o que el
  driver está desactualizado. En Linux instala `intel-media-driver` y `vpl-gpu-rt`.

**Laptop con dos GPUs (NVIDIA Optimus / gráficos conmutables de AMD).** El OpenGL de danser puede ejecutarse en
la GPU integrada. Abre **Configuración → Sistema → Pantalla → Gráficos** en Windows, agrega `danser-cli.exe`,
elige **Opciones → Alto rendimiento** y guarda. La configuración por programa del Panel de control de NVIDIA
también sirve.

**Revisa qué usó danser realmente.** danser escribe `danser.log` en su propia carpeta en cada ejecución. Incluye
la `danser-go version`, el fabricante/renderizador/versión de OpenGL que se usó de verdad (así ves qué GPU dibujó
los fotogramas) y la ruta y los argumentos de FFmpeg.

**`RENDER_TIMEOUT`.** Un render tardó más de 30 minutos y se detuvo. Suele pasar con el respaldo por CPU en un
equipo lento; prueba 720p, arregla el codificador de GPU o revisa el log del render en `data/logs/`.

**SmartScreen / Defender de Windows bloquea danser.** Los ejecutables de danser no están firmados. Descarga danser
solo desde sus [releases de GitHub](https://github.com/Wieku/danser-go/releases). Antes de extraer, puedes hacer
clic derecho en el zip → **Propiedades** → marcar **Desbloquear**. Si aun así aparece SmartScreen, elige
**Más información → Ejecutar de todas formas**. Si Defender pone un archivo en cuarentena, restáuralo y agrega
una exclusión para la carpeta de danser.

**PowerShell dice que "la ejecución de scripts está deshabilitada en este sistema" al usar `npm`.** Ejecuta
`npm.cmd` en lugar de `npm`, o permite scripts locales una vez: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

**`npm ci` intenta compilar `better-sqlite3`.** Usa Node.js 22 o 24 de 64 bits (hay binarios precompilados para
esas versiones); otras versiones necesitan Visual Studio Build Tools.

**Puerto en uso (`EADDRINUSE`).** Otro programa usa el puerto 3030. Define otro `PORT` en `.env` o busca el
proceso: `Get-NetTCPConnection -LocalPort 3030` (Windows) / `ss -ltnp 'sport = :3030'` (Linux).

**En Windows los renders fallan solo cuando se inicia en segundo plano.** El servicio tiene que correr en tu sesión
de escritorio, ver [Inicio rápido: Windows](#inicio-rápido-windows).

## Desarrollo

```sh
npm ci
npm run dev     # ejecuta el TypeScript directamente con tsx
npm test        # compila y luego ejecuta las pruebas de node:test
```

La CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) ejecuta las pruebas en Ubuntu y Windows (Node 24,
y Node 22 en Ubuntu) y un job de humo que descarga danser 0.12.1 en ambos sistemas y comprueba que
`npm run doctor` encuentre danser y FFmpeg y que la prueba de x264 pase. Los runners de CI no tienen GPU, así que
los codificadores por hardware solo se prueban cuando alguien ejecuta el doctor en un equipo real.

## Licencia y créditos

[MIT](LICENSE) © 2026 956zs.

- El renderizado lo hace [danser-go](https://github.com/Wieku/danser-go), de Wieku (no se incluye; descárgalo
  por separado).
- osu! es una marca comercial de ppy Pty Ltd. Este proyecto no está afiliado ni respaldado por ppy.
