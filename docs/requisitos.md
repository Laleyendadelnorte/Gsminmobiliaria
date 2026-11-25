# Matriz de requisitos — entrega de desarrollo

**IMPLEMENTADO** significa que existe código operativo para el alcance indicado. **PARCIAL** indica funcionalidades construidas con partes pendientes. **BLOQUEADO** se reserva a una dependencia externa concreta. Una tabla en la BD o una interfaz de proveedor por sí sola no equivale a flujo completo. Las evidencias ejecutadas se detallan en `verificacion.md`; pruebas omitidas no se cuentan como aprobadas.

| Requisito del maestro | Módulo / evidencia | Estado y alcance |
|---|---|---|
| Aplicación full-stack persistente y exportable | Next, PostgreSQL, migraciones; integración y E2E | IMPLEMENTADO para flujos descritos; sin repositorio público |
| Entornos, variables, lockfile, CI, Docker | `.env.example`, lockfile, workflow, Docker/compose | PARCIAL: Node probado; CI remoto y contenedores preparados sin ejecución |
| Identidad editorial GCM y 9 secciones | componentes/CSS, capturas navegador | IMPLEMENTADO; wordmark provisional y fotos ilustrativas |
| Responsive y accesibilidad | E2E 390/768/1024/1440, análisis axe | IMPLEMENTADO en los tamaños y escaneos probados: 11 pantallas/estados sin incidencias axe AA; no certificación WCAG ni prueba con todos los lectores |
| Login/bootstrap/roles/autorización | auth, backend tests | IMPLEMENTADO; roles en servidor, administración de miembros por UI pendiente |
| Invitación segura, sesiones, expiración/revocación | auth/portal; integración + E2E | IMPLEMENTADO; hash, cookies y acceso por oferta |
| OTP y recuperación por correo | reset-password operativo | BLOQUEADO para entrega de mensajes sin proveedor; integración OTP/correo aún debe desarrollarse |
| CRUD, búsqueda/filtros/paginación/duplicación/CSV | domain/import-export/properties | IMPLEMENTADO; CSV transaccional, filas inválidas e IDs separados |
| Ficha inmobiliaria extendida y documentos | esquema + editor | PARCIAL: campos principales completos; comisión/documentación/campos avanzados y documentos privados sin flujo completo |
| Galería privada, variantes y cuota | media, ledger; suite medios | IMPLEMENTADO para subida y lectura, MIME real, límites, WebP/AVIF, original privado, revocación |
| Gestión avanzada de galería | UI, media API | IMPLEMENTADO para fotografías: zoom/teclado, portada por orden, drag-and-drop y flechas, texto alternativo y retirada en UI. Vídeo/tour opcionales pendientes |
| S3 y cola multimedia | adaptador S3 + volumen privado | PARCIAL: disco probado; S3 externo sin credenciales/prueba, procesamiento síncrono acotado |
| CRM, preferencias, pipeline, notas y duplicados | domain/prospects | IMPLEMENTADO en servicios principales; duplicación confirmada no copia contactos/pagos |
| Tareas, próxima acción y detalle ampliado | schema/detail API | PARCIAL: historial/notas/ofertas y datos relacionados; editor de tareas y visualización íntegra del detalle pendientes |
| Asistente con acciones reales | ai/domain; 22 pruebas e integración E2E determinista | IMPLEMENTADO para persistencia, matching y borradores; el analizador sin proveedor es limitado y está rotulado |
| Anexo V2 con proveedor IA externo | adaptador OpenRouter | BLOQUEADO: emisión de clave rechazada `full_access_not_enabled`; aceptación V2 con LLM real NO completada |
| Deduplicación, aclaración, edición y diff | ai tests/contrato UI | IMPLEMENTADO; plan guardado, confirmación y versión esperada, rollback real |
| Matching 3–8, cero/parciales, monedas/razones | domain/ai tests | IMPLEMENTADO; no mezcla DOP/USD ni inventa fichas; pesos por defecto, editor de pesos pendiente |
| Portales, preview, publicar/pausar/revocar/duplicar | offers/portal, integración/E2E | IMPLEMENTADO; publicación humana, selección y edición manual, acceso nuevo por duplicado |
| Versiones y revertir | domain offer versions/revert | PARCIAL: API probada; selector de versiones/reversión en UI pendiente |
| Ruta privada y slug único/reservado | offers/APItests | IMPLEMENTADO en `/oferta/{slug}`; no autentica solo por slug |
| Wildcard DNS/TLS/host resolver | operación/DNS | BLOQUEADO sin dominio y DNS; resolver multi-host también requiere implementación antes de activar |
| Cliente: favoritos/comparar/interés/visita | portal, integración/E2E | IMPLEMENTADO; hasta 3 comparables y persistencia de interacciones |
| Mapa y filtros avanzados cliente | portal | PARCIAL: ubicación pública textual; sin mapa geográfico ni editor de coordenadas |
| Agenda, conflictos, holds y reprogramación | visits, tests, worker | IMPLEMENTADO; bloquea solapamiento de agente y propiedad, snapshot y expiración |
| Términos, RD$500, asistencia/devolución | payments/visits, E2E | IMPLEMENTADO exclusivamente sandbox; no confirma dinero real ni inventa política comercial |
| PaymentProvider, checkout real, transferencias | interfaz y sandbox | PARCIAL/BLOQUEADO: sandbox completo, pasarela no contratada; revisión de comprobantes/conciliación externa/reintentos no implementados |
| Firma webhook/replay/montos/ledger/reembolso | payments tests | IMPLEMENTADO en sandbox; firma sobre bytes originales y locks/idempotencia |
| Recordatorios, consentimiento y cola | notification_jobs | PARCIAL/BLOQUEADO: jobs bloqueados y persistidos, sin proveedor/worker de entrega; no se envían mensajes |
| KPIs, reportes/CSV, auditoría/configuración | dashboard/reports/audit/settings | IMPLEMENTADO para indicadores y configuración expuestos; acciones masivas y todas las opciones avanzadas pendientes |
| Relaciones, restricciones/índices/seed | migrations, integration | IMPLEMENTADO; modelo mínimo más ledger de almacenamiento; seed idempotente |
| Seguridad y privacidad | auth/media/API; suite de aislamiento | PARCIAL: controles y regresiones probados; auditoría independiente, retención/anónimo y revisión legal pendientes |
| Backups cifrados/restauración y persistencia | age/pg_dump/systemd | IMPLEMENTADO: cifrado y restauración real probados; copias externas y recuperación de máquina completa pendientes |
| 10k propiedades/10k prospectos/20k ofertas/100 sesiones | diseño/índices | IMPLEMENTADO como benchmark de lectura: 100 sesiones, 400 solicitudes válidas, dataset objetivo y 60k selecciones; no prueba sostenida de escrituras/IA/pagos |
| LCP ≤2.5 s | prueba de rendimiento descrita en evidencias | Mediana móvil 2.468 s (tres muestras 2.228–2.964 s), CPU 4× y red emulada; no garantía en todas las cargas |
| Exportación/documentación/GitHub | ZIP, README, docs, repositorio y workflow | IMPLEMENTADO; publicación en main y GitHub Actions verificados; sin despliegue de producción |

## Cierre de la fase siguiente

Primero activar credenciales de IA y repetir V2 desde una base nueva. Después completar los flujos parciales necesarios para operación real, auditar código/seguridad, probar contenedores, carga y S3; aprobar términos y privacidad, contratar proveedores y validar sus sandbox. Solo tras autorización publicar el repositorio y desplegar producción. Ninguno de estos pasos se presenta como ya ejecutado.
