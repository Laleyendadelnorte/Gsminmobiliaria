# Operación y despliegue

## Desarrollo actual

La demostración corre en una máquina Linux separada con Node 24 y PostgreSQL. La aplicación usa un servicio systemd persistente y HTTPS mediante un endpoint de desarrollo. No es un despliegue de producción ni un dominio adquirido. El enlace administrativo entregado contiene una credencial de desarrollo; conservarlo privado y desactivar `ENABLE_BOOTSTRAP_ACCESS` al adoptar el login convencional.

Código portable: `npm ci`, migrar, bootstrap, `npm run build`, `npm start`. Nunca borrar el volumen de BD al actualizar. Cambiar migraciones ya aplicadas causa un error de checksum: añadir una migración nueva. Reiniciar el proceso después de cambiar secretos. Guardar los secretos fuera del repositorio con permisos 0600.

Servicios de esta demostración:
- `workspace-zRjSnu-gcm.service`: Next.js en 127.0.0.1:3000, usuario sin privilegios `gcm`.
- `workspace-zRjSnu-gcm-worker.service`: mantenimiento de holds, sesiones y límites caducados.
- `workspace-zRjSnu-gcm-backup.timer`: copias locales cifradas. No constituye backup externo ante pérdida del disco completo.

Inspección: `systemctl status NOMBRE` y `journalctl -u NOMBRE`; salud: `GET /api/health` consulta PostgreSQL. Mantener los logs sin cuerpos de mensajes, tokens o claves. El request ID identifica fallos del router. La API no ofrece aún un sistema externo de alertas ni métricas distribuidas.

## Docker local

Copiar `.env.example` a `.env` y completar contraseñas aleatorias. `docker compose up -d postgres` inicia dependencias locales. Migrar desde Node con conexión a localhost; `docker compose --profile app up --build -d app` prepara la aplicación en contenedor. Para localhost HTTP usar desarrollo; las cookies de una imagen `NODE_ENV=production` requieren HTTPS. Configure un proxy TLS delante del contenedor para pruebas con imagen de producción.

El almacenamiento de desarrollo es el volumen privado persistente `media_data` del servicio app. No usa un servidor de objetos abandonado ni expone archivos por HTTP directamente. Para producción elegir un proveedor S3 administrado y soportado. La aplicación acepta `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`; crear previamente un bucket privado. No requiere ACL pública ni descarga directa del cliente: el backend autoriza las lecturas. La ruta por defecto `.storage/` está validada en esta entrega; el proveedor S3 remoto requiere prueba independiente con credenciales reales. No se ejecutó Docker en esta máquina; no se declara PASS de contenedores.

## Dominio y TLS

El modo entregado resuelve `/oferta/{slug}`. No existe un subdominio real por prospecto ni se ha adquirido `gcminmobiliaria.com`.

Para wildcard en una fase posterior: comprar/configurar el dominio autorizado, apuntar `*.dominio` al proxy, emitir certificado wildcard con ACME DNS-01 y guardar las credenciales DNS únicamente en el servidor. El proxy debe aceptar solo el dominio exacto o un único label de slug bajo ese dominio, rechazar hosts arbitrarios y reescribir internamente a `/oferta/{slug}`. Conservar el host original validado y la misma autenticación; no redirigir ni construir URLs a partir de un Host no validado. El resolver y pruebas de múltiples orígenes aún necesitan implementación; el control de origen actual se limita a `APP_URL`. No activar wildcard cambiando únicamente DNS. Slug neutral, único y normalizado; `admin`, `api` y `www` están reservados.

## IA y pagos

`OPENROUTER_API_KEY` se configura solo en servidor. No colocarla en variables `NEXT_PUBLIC_*`. El modelo es configurable; comprobar disponibilidad/costo y ejecutar la aceptación V2 con proveedor real. En este workspace la emisión de una clave fue rechazada con `full_access_not_enabled`; no hubo financiación ni llamadas facturadas. Consultar `ai.md`.

`PAYMENT_MODE=sandbox`: no se implementa cobro real. Incluso cambiar a live no contrata una pasarela ni habilita cargos. Seleccionar proveedor con checkout alojado/reembolsos, implementar adaptador y conciliación con reintentos durables, validar firma y sandbox externo; luego aprobar términos y revisión jurídica/fiscal. OTP, correo y recordatorios requieren proveedor, consentimiento y pruebas de entrega. Nunca marcar enviado/reembolsado por una petición sin confirmación verificable.

## Backup y restauración

Se utiliza [age](https://github.com/FiloSottile/age) y `pg_dump` custom. Guardar la identidad privada fuera del servidor en un gestor seguro; el servicio de backup solo necesita el destinatario público.

```sh
# Ejemplo de preparación operativa; no agregar la identidad a Git.
age-keygen -o /ruta/privada/identidad.age
# Obtener el destinatario público con age-keygen -y; exportar AGE_RECIPIENT.
npm run backup -- /ruta/backups/gcm.dump.age
# En OTRA base vacía, compatible y con permisos de migración:
# RESTORE_DATABASE_URL y AGE_IDENTITY_FILE provienen de entorno privado.
npm run restore -- /ruta/backups/gcm.dump.age
```

Se genera además `gcm.media.tar.age` cuando existe el directorio local de medios. Restaurarlo en un directorio nuevo con `age --decrypt ... | tar -xf - -C /directorio/vacio`, revisar propietario y asignar `MEDIA_ROOT`. El archivo de medios y la BD deben corresponder al mismo periodo; para un backup consistente bajo escrituras activas, poner cargas en mantenimiento o usar snapshots coordinados/versionado de objetos. S3 necesita backup/versionado propio.

La restauración no usa `--clean`: una base ocupada falla, evitando eliminación automática. Comparar migraciones, recuentos financieros y archivos; verificar acceso privado tras arrancar en un dominio de prueba. La prueba realizada y sus recuentos aparecen en `verificacion.md`. Backups y clave de desarrollo se guardan fuera del proyecto; no forman parte de la exportación.

## Costos y fase de producción

La máquina auxiliar de 4 GB fue elegida del catálogo de Solid, que indicaba US$24/mes más cargo de aprovisionamiento; facturación y cargos efectivos se consultan en Solid. Endpoint/relay, alojamiento definitivo, dominio, almacenamiento, correo, pasarela y LLM pueden generar cargos no confirmados aquí. No se inventan tarifas de transacción ni contratos activos. La solicitud posterior autoriza exportar a `Laleyendadelnorte/Gsminmobiliaria`; el estado de publicación debe verificarse con el SHA remoto. No autoriza un despliegue productivo ni una migración de datos. Véase `exportacion.md` para sustituir la infraestructura del workspace.
