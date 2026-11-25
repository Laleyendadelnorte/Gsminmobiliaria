# Exportación de GCM Inmobiliaria

Destino solicitado: [Laleyendadelnorte/Gsminmobiliaria](https://github.com/Laleyendadelnorte/Gsminmobiliaria), rama `main`. El nombre se conserva exactamente. La inspección inicial del 25-11-2026 encontró un repositorio público vacío y ningún historial Git en la raíz de origen. No se cambia la visibilidad. El resultado de la publicación y su SHA se entregan en el informe final; este documento no prueba por sí mismo un push.

## Inventario exportable

| Componente existente | Archivos principales |
|---|---|
| Frontend, CRM, inventario, agenda, finanzas y configuración | `src/app/`, `src/components/` |
| API y control de acceso | `src/app/api/[...path]/route.ts`, `src/server/router.ts`, `auth.ts`, `errors.ts` |
| Dominio inmobiliario, prospectos, preferencias y ofertas | `src/server/domain.ts`, `import-export.ts` |
| Asistente y herramientas con persistencia y confirmación | `src/server/ai.ts`, `docs/ai.md` |
| Portales privados personalizados, sesiones y medios | `src/server/portal.ts`, `media.ts`, `src/app/oferta/[slug]/` |
| Reservas, garantía, pagos y reembolsos sandbox | `src/server/visits.ts`, `payments.ts` |
| PostgreSQL, esquema y migraciones | `src/server/db.ts`, `migrations/001_core.sql`, `003_media_storage.sql` |
| Bootstrap, seed sintético, mantenimiento y backup | `scripts/` |
| Recursos visuales autorizados de demostración | `public/images/`, `docs/assets.md` |
| Dependencias exactas y configuración | `package.json`, `package-lock.json`, `tsconfig.json`, `next.config.ts`, `eslint.config.mjs` |
| Preparación Docker y CI | `Dockerfile`, `compose.yml`, `.dockerignore`, `.github/workflows/ci.yml` |
| Pruebas, especificación, evidencias y límites | `tests/`, `docs/`, `README.md` |

Se conserva la aplicación actual. El schema está en SQL; Drizzle inicializa el acceso, pero no existe un schema declarativo Drizzle independiente que exportar. Los portales actuales son rutas `/oferta/{slug}`. Un resolver por subdominios wildcard no está implementado; no se representa como componente terminado. No existe proveedor de pagos reales, OTP ni envío de recordatorios. La matriz [requisitos](requisitos.md) distingue lo implementado, lo parcial y lo bloqueado.

## Variables y dependencias

`.env.example` conserva nombres y plantillas. Los scripts de administración y Next cargan `.env.local`; el entorno del proceso prevalece. `npm test` no carga ese archivo automáticamente: exporte las variables o use el comando Node con `--env-file` descrito en `windows.md`. Los scripts Bash de backup y restore requieren variables exportadas en el proceso.

| Grupo | Variables | Uso |
|---|---|---|
| Aplicación y BD | `DATABASE_URL`, `APP_URL`, `NODE_ENV`, `NEXT_TELEMETRY_DISABLED` | PostgreSQL propio y origen exacto de la web |
| Acceso | `SESSION_SECRET`, `BOOTSTRAP_EMAIL`, `BOOTSTRAP_PASSWORD`, `BOOTSTRAP_NAME` | Secretos locales aleatorios y administrador inicial |
| Acceso especial de desarrollo | `ENABLE_BOOTSTRAP_ACCESS`, `BOOTSTRAP_TOKEN_HASH` | Desactivado en la plantilla; nunca exportar el enlace secreto |
| Datos demo | `ALLOW_DEMO_SEED` | Activación explícita del seed sintético |
| IA externa | `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | Clave propia en servidor; sin clave, modo determinista visible |
| Pagos de prueba | `PAYMENT_MODE`, `WEBHOOK_SECRET` | Adapter sandbox, firma de eventos de prueba; no habilita cobros live |
| Fotografías | `MEDIA_ROOT`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | Disco persistente privado o proveedor S3 compatible |
| Compose | `POSTGRES_PASSWORD` | Solo entorno privado local de contenedores |
| Recuperación operativa | `RESET_EMAIL`, `RESET_PASSWORD` | Cambio de contraseña y revocación de sesiones por operador |
| Copias | `AGE_RECIPIENT`, `AGE_IDENTITY_FILE`, `RESTORE_DATABASE_URL` | Cifrado y restauración a una base vacía separada |
| Pruebas | `RUN_BACKEND_INTEGRATION`, `AI_INTEGRATION_TEST`, `MEDIA_INTEGRATION_TEST`, `LOAD_TEST` | Activaciones explícitas en bases desechables |
| Navegador | `GCM_ACCESS_URL`, `CHROMIUM_PATH`, `BROWSER_PROXY` | Instancia de pruebas; proxy opcional, ningún relay Solid obligatorio |

## Servicios de Solid que no se exportan

| Recurso del workspace | Sustitución fuera de Solid |
|---|---|
| Máquina Linux y proceso alojado | Node 24 en equipo local/VPS o los archivos Docker incluidos; preservar volúmenes de PostgreSQL y medios |
| Endpoint HTTPS y dominio `solid.site` | Dominio propio y proxy TLS con certificado; `APP_URL` correcto. No se transfieren el hostname ni sus credenciales |
| Relay de navegador usado en QA | Acceso de red del entorno nuevo; omitir `BROWSER_PROXY` si no se necesita proxy |
| Systemd, temporizador de backups y servicios del host | Crear servicios propios para `npm start`, `npm run worker` y un planificador de `npm run backup`, bajo un usuario restringido |
| Adjuntos, enlaces privados y bookmarks de Solid | Documentación y assets incluidos; los enlaces privados de administración no son archivos exportables |
| Emisión de claves y facturación administrada | Contratar/configurar directamente proveedor LLM, S3, dominio y demás servicios con credenciales propias |

La lógica no requiere el token de workspace ni un SDK Solid. Los secretos del host y las unidades con rutas/credenciales locales no se copian. [Operación](operacion.md) detalla DNS wildcard, TLS, almacenamiento privado, supervisión y restauración. El bucket S3 debe existir y seguir privado; la aplicación autoriza y sirve los medios.

## Exclusiones y datos

Se excluyen `.env` reales, tokens, claves y certificados privados, configuración de autenticación GitHub, `.storage/`, uploads, recibos, bases/dumps, copias cifradas, `node_modules/`, `.next/`, cachés y `artifacts/`. Las migraciones SQL, seeds sintéticos, lockfile, archivos ocultos de configuración y evidencias seleccionadas sin credenciales sí se incluyen. No se exporta una copia del PostgreSQL de la demostración. El mayor archivo fuente está por debajo de los límites de GitHub; no se necesita Git LFS para esta entrega.

GitHub no es un respaldo de los datos de clientes. Si se autoriza una migración de datos más adelante, hacerla por separado: inventariar finalidad y destinatario, detener escrituras o coordinar snapshots, cifrar `pg_dump` y objetos privados, transferir por canal privado, custodiar la clave por separado, restaurar en una base vacía, comprobar filas/archivos y permisos, y revocar accesos antiguos conforme al plan aprobado. No adjuntar esos dumps, comprobantes ni claves a commits, issues o releases. No se ejecuta una migración de datos en esta exportación.

## Publicación y revisión

La publicación requiere una sesión autorizada de GitHub con escritura sobre este repositorio. Usar `gh auth login --web --git-protocol https --scopes workflow`, no pegar tokens en archivos. La capacidad `workflow` permite incluir el CI existente. Revisar los permisos que GitHub muestra. Si `main` está protegida, publicar una rama de exportación y abrir un PR. Si aparece historial nuevo en el destino, hacer fetch y revisar la integración antes de publicar. No usar force push, reset destructivo ni cambiar la visibilidad.

Verificación del resultado: `git status`, `git log -1`, `git ls-files` y `git ls-remote origin refs/heads/main`; el SHA local debe coincidir con el remoto para declarar publicación completada. Un ZIP o un commit local no demuestran esa coincidencia. El informe adjunto separa resultados ejecutados, límites y bloqueos.
