# Reglas de trabajo

## Cambios y despliegues

Respetar siempre este orden:

1. Hacer los cambios primero en el repositorio local y ejecutar las verificaciones correspondientes.
2. Crear el commit y pushearlo al remoto. Confirmar que el push terminó correctamente.
3. Solo si el usuario pide explícitamente actualizar o desplegar en producción, actualizar producción desde ese commit del remoto, compilar y reiniciar el servicio necesario.
4. Verificar que el servicio quede operativo y que producción use el commit desplegado.

No editar código directamente en producción ni copiar archivos locales al servidor para saltear el commit y el push. Si el push falla, no desplegar. Si producción tiene cambios locales, revisarlos y preservar su contenido antes de actualizar; no sobrescribirlos ni descartarlos automáticamente.

Hacer cambios, crear commits o pushear no autoriza actualizar producción. Después del push, detenerse: no actualizar, compilar ni reiniciar servicios en producción salvo que el usuario lo haya pedido explícitamente. Si el usuario pide el despliegue, respetar primero los pasos de cambios locales, verificación, commit y push.
