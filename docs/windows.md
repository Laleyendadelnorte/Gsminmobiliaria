# Ejecución local en Windows

El código conserva su estructura Next.js: un proceso sirve frontend y API; otro ejecuta mantenimiento. Esta guía describe PowerShell con Node 24 y PostgreSQL 17. La validación de esta entrega se ejecuta en Linux; no se ha probado un equipo Windows ni Docker Desktop.

## Preparar herramientas y base vacía

Instale Git para Windows, Node.js 24 con npm y PostgreSQL 17 con sus herramientas cliente. Abra una terminal nueva y compruebe `git --version`, `node --version`, `npm.cmd --version` y `psql --version`. Agregue la carpeta `bin` de PostgreSQL al PATH si el instalador no lo hizo. `npm.cmd` evita depender de la política de ejecución de scripts de PowerShell.

```powershell
git clone https://github.com/Laleyendadelnorte/Gsminmobiliaria.git
Set-Location Gsminmobiliaria
npm.cmd ci
Copy-Item .env.example .env.local
psql -U postgres -d postgres
```

Si la publicación aún no está disponible, extraiga el ZIP de entrega y use su carpeta raíz. En `psql`, cree usuario y base **solo si todavía no existen**:

```sql
CREATE ROLE gcm LOGIN;
\password gcm
CREATE DATABASE gcm OWNER gcm;
\q
```

`\password` solicita la contraseña sin incluirla en un archivo SQL versionado. Use una contraseña aleatoria propia. Si contiene caracteres especiales, codifíquelos como componente de URL en `DATABASE_URL`.

## Configuración privada

Abra `.env.local` en su editor. Complete `DATABASE_URL`, `BOOTSTRAP_EMAIL` y `BOOTSTRAP_PASSWORD`; mantenga `APP_URL=http://localhost:3000`, `NODE_ENV=development`, `ENABLE_BOOTSTRAP_ACCESS=false` y `PAYMENT_MODE=sandbox`. Deje vacía `OPENROUTER_API_KEY` para trabajar en modo determinista. Nunca pegue credenciales en `.env.example`.

Este ejemplo genera secretos locales sin imprimirlos; ejecútelo una sola vez sobre la plantilla nueva:

```powershell
$config = Get-Content .env.local -Raw
$sessionSecret = node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('hex'))"
$webhookSecret = node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('hex'))"
$config = $config.Replace('SESSION_SECRET=REPLACE_WITH_48_RANDOM_BYTES', "SESSION_SECRET=$sessionSecret")
$config = $config.Replace('WEBHOOK_SECRET=REPLACE_WITH_48_RANDOM_BYTES', "WEBHOOK_SECRET=$webhookSecret")
[IO.File]::WriteAllText((Join-Path $PWD '.env.local'), $config, [Text.UTF8Encoding]::new($false))
Remove-Variable config, sessionSecret, webhookSecret
```

Mantenga el archivo privado, fuera de carpetas compartidas; el usuario de Windows que ejecuta la aplicación debe poder leerlo. Cambie las contraseñas de plantilla antes de continuar. No cargue datos reales durante estas pruebas.

## Migrar, cargar demo y arrancar

```powershell
npm.cmd run db:migrate
npm.cmd run bootstrap
$env:ALLOW_DEMO_SEED = 'true'
npm.cmd run db:seed
Remove-Item Env:ALLOW_DEMO_SEED
npm.cmd run dev
```

Entre en `http://localhost:3000` con el administrador configurado. El seed es opcional e idempotente. En otra terminal, dentro del proyecto:

```powershell
npm.cmd run worker
```

Los scripts TypeScript de administración y Next cargan `.env.local`. El worker elimina holds y sesiones caducados; no envía correo ni ejecuta reembolsos automáticos. `Ctrl+C` detiene cada proceso.

## Comprobaciones

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

Sin las variables de integración las pruebas de BD quedan omitidas. Para ejecutarlas, cree otra base vacía `gcm_export_gcm_test`, propiedad de `gcm`, usando `psql`. En una terminal exclusiva de pruebas establezca `$env:DATABASE_URL` con esa conexión privada y:

```powershell
$env:RUN_BACKEND_INTEGRATION = 'true'
$env:AI_INTEGRATION_TEST = '1'
$env:MEDIA_INTEGRATION_TEST = '1'
npm.cmd run db:migrate
node --env-file=.env.local --import=tsx --test tests/ai.test.ts tests/backend.test.ts tests/media.test.ts
Remove-Item Env:DATABASE_URL, Env:RUN_BACKEND_INTEGRATION, Env:AI_INTEGRATION_TEST, Env:MEDIA_INTEGRATION_TEST
```

Las variables establecidas en la terminal tienen prioridad sobre el archivo con Node. Confirme el nombre de la base de pruebas antes de migrar. No ejecute E2E ni carga contra datos reales. Las pruebas de navegador necesitan `CHROMIUM_PATH` apuntando a un ejecutable instalado, `APP_URL` y un enlace administrativo de una instancia de pruebas en `GCM_ACCESS_URL`; no guarde ese enlace en Git.

## Shell, contenedores y servidor compilado

`npm run assets`, `backup` y `restore` invocan Bash. Use WSL2 con Bash, `curl`, `age`, `pg_dump` y `pg_restore` para ellos; no se anuncia compatibilidad PowerShell nativa de esos scripts. Las imágenes demo ya están incluidas, por lo que no es necesario regenerarlas para arrancar.

El `Dockerfile` y `compose.yml` existentes están incluidos. Para usar solo PostgreSQL en Docker Desktop, prepare `.env` con `POSTGRES_PASSWORD` privado y ejecute `docker compose up -d postgres`; no lo combine con otro PostgreSQL ocupando el puerto 5432. La aplicación Node puede seguir usando `.env.local` y localhost. El perfil `app` genera una imagen de producción que necesita un proxy HTTPS; véase [operación](operacion.md). No se ha validado Docker en esta exportación.

`npm.cmd run build` compila. `npm.cmd start` sirve el resultado en 127.0.0.1:3000; para sesiones en modo producción configure HTTPS delante del proceso y el `APP_URL` externo. Mantenga `npm.cmd run dev` para pruebas locales HTTP.
