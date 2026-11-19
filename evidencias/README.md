# Evidencias técnicas

Evidencia generada para esta entrega:

- `consulta-sql.txt`: salida de `docs/verificacion-sql.sql`, con conteos, fechas, SRID, validez geométrica, niveles de alerta y una consulta `ST_Covers` en Armenia.

El recorrido implementado es interacción → endpoint HTTP → consulta PostGIS → JSON/GeoJSON → Leaflet. Para reproducirlo, inicia el servidor con `npm.cmd start`, abre `http://127.0.0.1:8000` y consulta `/api/health`, `/api/alertas` y `/api/espacial`.
