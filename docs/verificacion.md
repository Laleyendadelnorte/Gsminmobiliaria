# Informe de verificación — 25 de noviembre de 2026

Aplicación de desarrollo con información ficticia. Node 24.22.3, Next.js 16.4.6, PostgreSQL y Chromium 156 en máquina Linux auxiliar de 4 GB. Código y estado reales; ninguna prueba con proveedor LLM ni dinero real se cuenta como aprobada.

## Pruebas ejecutadas

| Comprobación | Resultado |
|---|---|
| `npm run lint` | PASS, cero errores y advertencias en la última ejecución |
| `npm run typecheck` | PASS, TypeScript estricto |
| `npm run build` | PASS, compilación Next de producción usada para la demo privada |
| `npm test` con integración backend/IA/medios | **48 PASS, 0 FAIL, 0 SKIP**, 10.0 s en la última ejecución |
| `npm run test:e2e` | 12 pasos del flujo completo en Chromium; ver JSON de evidencia |
| `npm run test:gallery` | Subida real de 2 fotos, orden por teclado, alt persistido, retirada y lectura autenticada verificadas |
| `npm run test:accessibility` | 11 pantallas/estados, cero violaciones detectadas por axe en reglas WCAG 2 A/AA y 2.1 AA |
| Backup cifrado + restauración separada | PASS: 9 tablas con igualdad exacta de contenido y 10 archivos de medios idénticos |
| Reinicio del servicio | PASS: fingerprint de 10 tablas idéntico antes/después, health ready y navegador nuevo autenticado |
| IA con proveedor externo | BLOQUEADO, sin clave; no ejecución real del LLM |
| Pasarela bancaria/tarjetas/reembolsos reales | BLOQUEADO; adapter sandbox solamente |
| Docker/Compose en su plataforma | Archivos preparados, NO ejecutados; no se declara PASS |
| GitHub Actions | PASS tras publicar; ver actualización de exportación al final |

El conjunto de 48 pruebas incluye 22 de IA, 20 backend y 6 medios (contando los tests padre de integración en la numeración del runner). Los tres conjuntos usan PostgreSQL real, transacciones y bases desechables. Se verifican rollback, idempotencia, aislamiento, autorizaciones, CSV, conservación de PATCH, coincidencias cero/parciales, versiones, publicación y slug, reservas concurrentes, importes manipulados, firma y replay, asistencia, reembolso, ledger inmutable y revocación de medios.

E2E: login y credencial inválida, enlace privado en contexto nuevo, 9 secciones en 390/768/1024/1440 sin desbordamiento, alta y modificación persistente, imagen inválida, instrucción única de Alejandro con acciones reales en modo determinista, repetición sin duplicados, aprobación humana, portal en navegador separado, favoritos, términos/visita/pago sandbox/asistencia/devolución idempotente, ID ajeno, revocación y sesión nueva. No hubo errores JavaScript en la ejecución registrada. La primera ejecución partió sin Alejandro; ejecuciones posteriores reutilizan el mismo prospecto para comprobar deduplicación.

El análisis axe no equivale a certificación de accesibilidad: no sustituye pruebas con usuarios, todos los lectores de pantalla, dispositivos o condiciones. Se corrigieron etiquetas de campos, nombre accesible de diálogos y contraste. El drag-and-drop tiene alternativa mediante botones de teclado. Los resultados se conservan en `docs/evidence/`. Una comprobación final adicional verificó el dashboard a 320 y 1920 px, además de 390, después del reinicio.

## Rendimiento móvil medido

Dashboard autenticado, Chromium, viewport 390×844, CPU ralentizada 4×, caché deshabilitada, red emulada de 1.6 Mbps bajada / 0.75 Mbps subida / 150 ms de latencia, acceso HTTPS mediante relay. Tres muestras de LCP: **2964, 2228 y 2468 ms**. Mediana **2468 ms**, dentro del objetivo de 2.5 s por mediana; una muestra excede el objetivo. No es una garantía para todo dispositivo o carga.

Las fotografías adaptadas por `srcset`, tamaños de miniaturas y carga diferida redujeron los bytes transferidos en ese escenario de aproximadamente 1.06 MB a **227,917 bytes**. La medición inicial fue 6.256 s de mediana; el reporte final contiene los valores tras la optimización. Los assets subidos pueden tener tamaños y rendimiento diferentes.

## Dataset y concurrencia

Base desechable: 10.000 propiedades, 10.000 prospectos, 20.000 ofertas y 60.000 relaciones oferta-propiedad. 100 sesiones autenticadas distintas, 100 clientes concurrentes, cuatro lecturas por cliente. **400 respuestas válidas, cero errores**, 9.46 s, 42.29 solicitudes/s.

| Ruta (20 elementos por página) | p50 | p95 | Máximo |
|---|---:|---:|---:|
| Propiedades | 1698 ms | 2119 ms | 2126 ms |
| Prospectos | 1332 ms | 1738 ms | 2082 ms |
| Ofertas | 3954 ms | 4111 ms | 4161 ms |
| Dashboard | 2266 ms | 2680 ms | 2905 ms |

Transporte HTTP loopback; aplicación y PostgreSQL en la misma máquina de 4 GB. No incluye tráfico de navegador, imágenes, LLM, pagos ni escrituras sostenidas. Esta ejecución demuestra el comportamiento de ese escenario de lectura, no una capacidad comercial garantizada de 100 usuarios operando todos los módulos. El listado de ofertas debe seguir siendo un foco de optimización bajo concurrencia.

## Alcance de la aceptación V2

Se verificó persistencia real de perfil, preferencias, selección, tema, slug, borrador y garantía, publicación humana y portal privado. **La aceptación V2 con IA externa no está completada**: OpenRouter no pudo emitir una clave porque Solid respondió `403 full_access_not_enabled`. El modo determinista es una alternativa funcional limitada y está claramente identificado. No hubo financiación exitosa ni se simulan llamadas a un modelo.

La matriz `requisitos.md` detalla otros componentes parciales: documentos, tareas completas, versión/reversión en UI, wildcard, OTP/correo, transferencias manuales, proveedores/colas de entrega, retención y revisión legal. La exportación posterior a GitHub está verificada; no se ha desplegado producción.

## Actualización de exportación a GitHub

El commit de exportación inicial `f228e87675a7d0719daa395edbf86a9dab2b6ef9` se publicó en `main` de [Laleyendadelnorte/Gsminmobiliaria](https://github.com/Laleyendadelnorte/Gsminmobiliaria), conservando su visibilidad pública. Se comparó el SHA remoto y se hizo un clon limpio desde GitHub con verificación completa de `MANIFEST.sha256`.

[GitHub Actions — ejecución 45640217082](https://github.com/Laleyendadelnorte/Gsminmobiliaria/actions/runs/45640217082) terminó con resultado **success**: instalación, migraciones PostgreSQL, lint, TypeScript, pruebas y build. Esta comprobación se suma a la instalación aislada documentada en `evidence/export-validation.json`; las limitaciones de ese JSON describen la fase previa al push. La revisión posterior solo actualiza documentación y evidencia de publicación.
