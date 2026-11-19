CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS municipios (
    codigo_dane VARCHAR(6) PRIMARY KEY,
    nombre TEXT NOT NULL,
    departamento TEXT NOT NULL,
    area_km2 DOUBLE PRECISION,
    altitud_m INTEGER,
    geom geometry(Geometry, 4326) NOT NULL,
    fuente TEXT NOT NULL DEFAULT 'DANE — Marco Geoestadístico Nacional 2024'
);

CREATE TABLE IF NOT EXISTS niveles_alerta (
    nivel SMALLINT PRIMARY KEY,
    nombre TEXT NOT NULL,
    color CHAR(7) NOT NULL,
    descripcion TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alertas_deslizamiento (
    id BIGSERIAL PRIMARY KEY,
    municipio_codigo VARCHAR(6) NOT NULL REFERENCES municipios(codigo_dane),
    nivel SMALLINT NOT NULL REFERENCES niveles_alerta(nivel),
    fecha DATE NOT NULL,
    fuente_id TEXT,
    lluvia_acumulada_3d NUMERIC(8, 2),
    lluvia_acumulada_10d NUMERIC(8, 2),
    dias_con_lluvia NUMERIC(6, 2),
    CONSTRAINT uq_alerta_municipio_fecha UNIQUE (municipio_codigo, fecha)
);

ALTER TABLE alertas_deslizamiento ADD COLUMN IF NOT EXISTS lluvia_acumulada_3d NUMERIC(8, 2);
ALTER TABLE alertas_deslizamiento ADD COLUMN IF NOT EXISTS lluvia_acumulada_10d NUMERIC(8, 2);
ALTER TABLE alertas_deslizamiento ADD COLUMN IF NOT EXISTS dias_con_lluvia NUMERIC(6, 2);

CREATE TABLE IF NOT EXISTS precipitacion_diaria (
    municipio_codigo VARCHAR(6) NOT NULL REFERENCES municipios(codigo_dane),
    fecha DATE NOT NULL,
    precipitacion_mm NUMERIC(8, 2),
    modelo TEXT NOT NULL DEFAULT 'ECMWF IFS (histórico)',
    PRIMARY KEY (municipio_codigo, fecha)
);

CREATE INDEX IF NOT EXISTS ix_municipios_geom ON municipios USING GIST (geom);
CREATE INDEX IF NOT EXISTS ix_alertas_fecha_nivel ON alertas_deslizamiento (fecha, nivel);
CREATE INDEX IF NOT EXISTS ix_alertas_municipio_fecha ON alertas_deslizamiento (municipio_codigo, fecha DESC);
CREATE INDEX IF NOT EXISTS ix_precipitacion_fecha ON precipitacion_diaria (fecha);

INSERT INTO niveles_alerta (nivel, nombre, color, descripcion) VALUES
    (0, 'Sin registro', '#8A949D', 'No hay una alerta registrada para el municipio y fecha consultados.'),
    (1, 'Baja', '#EBCB46', 'Amenaza baja reportada por IDEAM.'),
    (2, 'Moderada', '#F28C45', 'Amenaza moderada reportada por IDEAM.'),
    (3, 'Alta', '#D94D4D', 'Amenaza alta reportada por IDEAM.')
ON CONFLICT (nivel) DO UPDATE SET
    nombre = EXCLUDED.nombre,
    color = EXCLUDED.color,
    descripcion = EXCLUDED.descripcion;
