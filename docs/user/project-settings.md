# Customize a project icon

T3 Code selects a project icon automatically. It checks `t3.json`, common favicon and app icon
paths, and icon links in project HTML files.

To choose a different icon:

1. Open **Settings** and select **Projects**.
2. Select the project.
3. Under **Appearance**, select **Choose a project file**.
4. Search for an image file and select it.

T3 Code supports SVG, PNG, ICO, JPEG, GIF, AVIF, and WebP files. The selected path applies to
each checkout in the project group and appears on your connected clients.

To use automatic detection again, select **Automatic**.

## Model for new threads

New projects use **Use last selected model**. Choosing a model or reasoning level in the composer
remembers that choice on this device, including after restarting the app. Opening an older thread
does not change it. Existing threads keep their own model.

In **Settings → Projects → New threads → Model**, choose **Always start with** to set a model
and reasoning level for that project. This applies to every checkout in the project group.
Changing the model in one thread does not change that project setting.

Existing project defaults are preserved. If a project keeps starting with an unwanted model,
switch it to **Use last selected model**. New projects no longer save an automatic model override.

If the selected model is unavailable in a new-thread composer, a notice identifies
the fallback. The fallback does not replace your remembered choice. Model choices are remembered
separately on each device.
