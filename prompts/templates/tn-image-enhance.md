<!--
name: tn-image-enhance
description: Image-to-image prompt for ENHANCING a licensed real photograph while preserving its geography.
config_vars:
runtime_vars: destination_name_en, source_description
-->
Enhance this real photograph of {{destination_name_en}}, Tunisia. It is documentary material: the place must stay exactly as it is.

What the photo shows: {{source_description}}

Allowed improvements:
- Lighting and exposure balance, natural color correction, clarity, fine detail and noise reduction.
- Gentle straightening or cropping that keeps every meaningful element in frame.

Not allowed:
- Adding, removing, moving or reshaping landmarks, mountains, rock formations, coastlines, rivers, lakes, vegetation, buildings, roads, people or animals.
- Changing the season, weather, time of day or sky in a way that misrepresents the scene.
- Stylizing it into a painting or artwork.
- Adding text, logos, signatures, borders or watermarks.

Return the enhanced photograph with the same geography and composition as the original.
