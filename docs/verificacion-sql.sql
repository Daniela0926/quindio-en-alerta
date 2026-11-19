-- Conteo, periodo, SRID y geometrías de la geodatabase.
SELECT
    (SELECT COUNT(*) FROM municipios) AS municipios,
    (SELECT COUNT(*) FROM alertas_deslizamiento) AS alertas,
    (SELECT COUNT(*) FROM precipitacion_diaria) AS filas_precipitacion,
    (SELECT MIN(fecha) FROM alertas_deslizamiento) AS primera_alerta,
    (SELECT MAX(fecha) FROM alertas_deslizamiento) AS ultima_alerta,
    (SELECT ST_SRID(geom) FROM municipios LIMIT 1) AS srid,
    (SELECT BOOL_AND(ST_IsValid(geom)) FROM municipios) AS geometrias_validas;

-- Distribución del último nivel reportado por municipio en el periodo cargado.
WITH ultimas AS (
    SELECT DISTINCT ON (municipio_codigo)
           municipio_codigo, nivel, fecha
    FROM alertas_deslizamiento
    WHERE fecha BETWEEN DATE '2026-01-01' AND (SELECT MAX(fecha) FROM alertas_deslizamiento)
    ORDER BY municipio_codigo, fecha DESC
)
SELECT n.nombre AS nivel, COUNT(*) AS municipios
FROM ultimas u
JOIN niveles_alerta n ON n.nivel = u.nivel
GROUP BY n.nivel, n.nombre
ORDER BY n.nivel;

-- Operación espacial equivalente a la consulta de punto del visor.
SELECT m.codigo_dane, m.nombre, ST_Covers(
    m.geom,
    ST_SetSRID(ST_MakePoint(-75.6811, 4.5339), 4326)
) AS punto_dentro
FROM municipios m
WHERE ST_Covers(m.geom, ST_SetSRID(ST_MakePoint(-75.6811, 4.5339), 4326));

-- Respuesta comparable con /api/municipios/63001.
SELECT m.nombre, a.fecha, n.nombre AS nivel,
       a.lluvia_acumulada_3d, a.lluvia_acumulada_10d,
       p.precipitacion_mm, p.modelo
FROM municipios m
JOIN alertas_deslizamiento a ON a.municipio_codigo = m.codigo_dane
JOIN niveles_alerta n ON n.nivel = a.nivel
LEFT JOIN precipitacion_diaria p
  ON p.municipio_codigo = a.municipio_codigo AND p.fecha = a.fecha
WHERE m.codigo_dane = '63001'
ORDER BY a.fecha DESC
LIMIT 10;
