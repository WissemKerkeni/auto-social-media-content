<!--
name: tn-caption-request
description: User message for caption generation. Runtime vars are filled by n8n from the database row of the claimed post.
config_vars: base_hashtags
runtime_vars: destination_name_ar, destination_name_en, region, landscape_type, image_origin, image_description, verified_facts_json, source_attribution, disclosure_text
-->
Write the post for this destination.

DESTINATION: {{destination_name_ar}} / {{destination_name_en}}
REGION: {{region}}
LANDSCAPE_TYPE: {{landscape_type}}
IMAGE_ORIGIN: {{image_origin}}
IMAGE_DESCRIPTION: {{image_description}}
SOURCE_ATTRIBUTION: {{source_attribution}}
DISCLOSURE_TEXT: {{disclosure_text}}

VERIFIED_FACTS (JSON; the only facts you may state):
{{verified_facts_json}}

Hashtags: start from these page hashtags and add a few specific to the destination and landscape (Arabic-script and English), staying within the limit: {{base_hashtags}}
