# Kodradev OpenCode Subagent Statusline

Paquete e ID del plugin: `kodradev-opencode-subagent-statusline`.

Plugin **TUI para OpenCode V2**: muestra subagentes de la sesión visible en la barra lateral, sin modificar OpenCode ni añadir herramientas al modelo.

```text
Subagents
● 1 running · ✓ 2 done · × 0 error

● Revisar autenticación
  ◷ 00:30 · 12.2k tok
✓ Revisar componentes
  ◷ 00:20 · 13.8k tok
```

## Instalación local

Requisitos: OpenCode **2.0.23 o posterior dentro de V2**, Node.js 24 y pnpm 11.9.0 para compilar.

Desde esta carpeta:

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
```

### Solo en esta carpeta

Esta carpeta incluye `opencode.jsonc` con `"plugins": ["./dist"]`. Después de compilar, reabre OpenCode desde esta carpeta para cargar los entrypoints compilados `index.js` y `tui.js`. No hace falta cambiar configuración global.

Para otro proyecto, añade la ruta del paquete a su `opencode.jsonc`, conservando las demás entradas:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "C:/Users/Joaku/Desktop/Dev/personal/opencode-plugins/opencode-subagent-statusline"
  ]
}
```

El entrypoint de servidor está vacío: permite que OpenCode descubra el entrypoint `./tui` del paquete sin registrar herramientas, hooks ni trabajo en segundo plano.

### Global, solo para la terminal

Como alternativa, añade la ruta al array `plugins` de tu `~/.config/opencode/cli.json`. Conserva las demás entradas y preferencias:

```jsonc
{
  "plugins": [
    "C:/Users/Joaku/Desktop/Dev/personal/opencode-plugins/opencode-subagent-statusline"
  ]
}
```

Reabre la TUI y muestra la barra lateral. El panel aparece cuando la sesión tiene subagentes. La configuración global no se modifica automáticamente.

No necesitas configurar el paquete en ambos archivos. `opencode.json(c)` permite alcance por proyecto; `cli.json` lo activa globalmente para la TUI, incluso contra servidores remotos, mediante el cliente autenticado de OpenCode.

## Comportamiento

- Incluye hijos y descendientes de la sesión visible; no mezcla otras sesiones ni hermanos.
- Prioriza subagentes en ejecución, luego pendientes, errores, interrumpidos y finalizados.
- `running` procede del estado activo y de eventos de ejecución; `done`, `error` e `interrupted` son resultados diferentes. Una sesión inactiva sin resultado aparece como `pending`, no como completada.
- La duración suma intervalos `execution.started` → finalización. Incluye esperas dentro de una ejecución, pero excluye pausas entre ejecuciones al reanudar una sesión.
- Recupera duración desde el log público de la sesión al abrir el panel. `--:--` indica duración todavía no cargada o no disponible; no se estima desde la fecha de creación.
- Tokens acumulados por subagente: entrada + salida + razonamiento + caché de lectura/escritura, siguiendo `TokenUsage.total` de OpenCode. No equivalen al tamaño actual del contexto ni incluyen tokens de otros descendientes.
- El reloj se actualiza localmente cada segundo solo mientras hay ejecución. Los cambios de estado y uso llegan por eventos, sin polling periódico.
- Los logs se leen con un máximo de cuatro solicitudes simultáneas. Al reconectar se vuelve a descubrir la jerarquía y se recuperan eventos faltantes.
- Colores del tema activo, títulos truncados y símbolos de estado independientes del color.
- Filas compactas de dos líneas: título y duración/tokens, sin etiqueta del agente ni líneas vacías entre subagentes.
- Haz clic en un título para abrir la sesión del subagente, o en `+N more` para ampliar la lista.
- El panel se oculta cuando no hay subagentes. Desmontar el panel cancela lecturas, suscripciones y reloj.

### Ubicación

Usa el slot público `prepend: "sidebar.content"`: al principio del contenido de la barra lateral, conservando las secciones nativas. V2 no documenta un slot específico inmediatamente anterior a `Context`; la posición exacta depende del layout de OpenCode y de otros plugins.

## Opciones

```jsonc
{
  "plugins": [
    {
      "package": "C:/Users/Joaku/Desktop/Dev/personal/opencode-plugins/opencode-subagent-statusline",
      "options": {
        "maxItems": 3,
        "showTokens": true
      }
    }
  ]
}
```

| Opción | Predeterminado | Descripción |
| --- | --- | --- |
| `maxItems` | `3` | Límite inicial de filas, entre 1 y 50. Nunca oculta subagentes en ejecución. `+N more` muestra el resto. |
| `showTokens` | `true` | Muestra uso de tokens junto a la duración. |

## Desarrollo

```powershell
pnpm run typecheck
pnpm run build
```

`build` compila TypeScript y transforma JSX para el renderer Solid/OpenTUI. Las dependencias del renderer permanecen externas para usar las instancias del host. No requiere Bun para compilar.

No incluye tests. La compatibilidad visual y la posición final requieren verificación en una TUI real.

## Publicación en npm

El paquete se publica como `kodradev-opencode-subagent-statusline`. El workflow `.github/workflows/publish.yml` instala, comprueba tipos y empaqueta con pnpm; usa npm CLI solo para publicar el tarball con autenticación OIDC.

### Primera publicación

1. Crea una cuenta en [npmjs.com](https://www.npmjs.com), activa 2FA e inicia sesión con `pnpm login`.
2. Desde `main`, con el árbol de trabajo limpio y actualizado, ejecuta `pnpm publish --access public` para crear el paquete con la versión `0.1.0`.
3. En npm, abre el paquete → **Settings → Trusted publishing → GitHub Actions** y configura:
   - Organization or user: `KodraDev`
   - Repository: `opencode-subagent-statusline`
   - Workflow filename: `publish.yml`
   - Environment name: vacío.
   - Permite publicación directa mediante **npm publish**.
4. La primera publicación OIDC debe completarse dentro de los dos días posteriores a configurar el publisher; si expira, recréalo antes de la siguiente release.

### Versiones siguientes

1. Incrementa `version` en `package.json` (por ejemplo, a `0.1.1`), crea el commit y súbelo a `main`.
2. Crea una release de GitHub con un tag que coincida exactamente: `v0.1.1`.
3. Al publicar la release, Actions compila y publica en npm sin `NPM_TOKEN`. No reutilices versiones ya publicadas. El workflow rechaza prereleases; utiliza versiones estables.

La publicación de una release `v0.1.0` después de publicarla manualmente fallará porque esa versión ya existe. Usa la siguiente versión para comprobar OIDC.

Antes de distribuir el paquete, elige una licencia y añade su archivo y el campo `license` a `package.json`; este repositorio todavía no declara una.

Documentación: [plugins CLI de OpenCode V2](https://opencode.ai/v2/docs/build/plugins/cli).
