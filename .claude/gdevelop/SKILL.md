---
name: gdevelop
description: How to work on the game through the slim GDevelop funnel (5 tools over the live editor). Use before any GDevelop change: adding or editing objects, placing instances, terrain and scattered-model edits, events (including reworking existing ones), resources, gameplay tests.
---

# GDevelop through the funnel

## The five tools

- `gdevelop({function_name, arguments})` runs every GDevelop function. `arguments` is passed as is, GDevelop checks it.
- `docs({what})` gives full schemas and guides. `what` is one of `event_script_guide`, `script_api`, `gameplay_guide`, `schema`, `extension`, `search`, `javascript`. `docs({what: "schema", name: "<function>"})` for one schema (about 2k tokens).
- `read_game_project_json`, `save_project` and `create_project` are their own tools.
- Never call a GDevelop function name as a tool. `put_3d_instances` is `gdevelop({function_name: "put_3d_instances", arguments})`.
- Extension docs: `docs({what: "extension", names: ["Sprite", "Physics3D"]})`. The funnel turns the list into the comma-separated string GDevelop expects, so `gdevelop({function_name: "read_full_docs", arguments: {extension_names: "Sprite, Physics3D"}})` is the same read.
- `list_game_templates` is a `gdevelop` function and `create_project` is a tool. Both are unused: this project already exists.

## `scope`, exactly

Never a string, always an object with `type`:

- Scene (instances, events, scene properties): `{type: "scene", scene_name: "Game Scene"}`
- External layout: `{type: "external_layout", external_layout_name: "<name>"}`
- Custom object variant: `{type: "custom_object_variant", extension_name, custom_object_name, variant_name: ""}`
- A function's events (`generate_events`, `read_events_source`): `extension`, `custom_behavior` or `custom_object` type with `function_name`
- Gameplay tests, and variables on the project: `{type: "project"}`

## Function sheet

Required arguments first, `?` is optional. `…` marks a signature I shortened: `docs({what: "schema", name})` is the truth.

- Objects: `create_or_replace_object(scope, object_type, object_name, replace_existing_object?, duplicated_object_name?, asset_id?, search_terms?, …)`, `inspect_object_properties_effects(scope, object_name)`, `change_object_properties_effects(scope, object_name, delete_this_object?, changed_properties?, changed_effects?, raw_json?, renamed_animations?, renamed_points?)`.
- Behaviors: `add_behavior(scope, object_name, behavior_type)`, `inspect_behavior_properties(scope, object_name, behavior_name)`, `change_behavior_property(scope, object_name, behavior_name, delete_this_behavior?, changed_properties?)`.
- Instances: `describe_instances(scope, filter_by_object_name?, surface_beneath?, …)`, `put_3d_instances(scope, layer_name, brush_kind, object_name?, brush_position?, brush_position_anchor?, brush_size?, brush_end_position?, existing_instance_ids?, new_instances_count?, instances_size?, instances_rotation?, instances_hidden?, drop_to_surface?)`, `put_2d_instances(…)` (see below), `change_instances_raw_json(scope, changes)`.
- Scenes: `create_scene(…)`, `inspect_scene_properties_layers_effects(scope)`, `change_scene_properties_layers_effects_groups(scope, changed_properties?, changed_layers?, changed_layer_effects?, changed_groups?, …)`.
- Project: `inspect_project_properties_resources(filter_by_resource_name?, list_all_resources?)`, `change_project_properties_resources(changed_properties?, changed_resources?, added_resources?)`, `add_or_edit_variable(variable_scope, variables, scope?, object_name?, instance_id?)`, `inspect_variables(variable_scope, …)`.
- Events: `read_events_source(scope, function_name?, event_ids?, search?, object_names?, sub_events_depth?, max_chars?, js_from_line?)`, `generate_events(scope, event_batches, extension_names_list, objects_list, estimated_complexity, function_name?)`.
- Tests and scripts: `run_gameplay_test(scope, test_name, source?, description?, persist?, timeout_ms?)`, `change_gameplay_tests(scope, changes)`, `run_script(title, js_code)`.
- Extensions and custom objects, behaviors and functions: the `create_*`, `change_*` and `inspect_extension` functions. Fetch the schema before using one.
- Other callable: `read_full_docs(extension_names)`, `search_docs(query)`, `read_javascript_reference(names)`, `search_object_asset_store(search_terms, allowed_object_types?)`, `search_resource_store(search_terms, resource_kind)`, `read_script_api_definition()`, `read_gameplay_test_harness_guide()`.

## Recipes

- Before any edit: read first (`read_game_project_json`, `describe_instances`, `inspect_object_properties_effects`). Object names are exact (`cabin` is lowercase, the truck is `pickup_truck`, the scene is "Game Scene").
- Back up `game-jam-01.json` to `D:/game-jam-01-scratch/backups/` before a big pass, and before the `save_project` that makes it permanent. Call `save_project` after each coherent change.
- New object from a file we own: the editor cannot register it. Follow `.claude/rules/gdevelop-mcp.md` (close the editor, register, reopen). The funnel outlives the editor: a call made while GDevelop is shut returns "GDevelop is not reachable at http://127.0.0.1:52520/mcp" and the next call after reopening reconnects by itself. No MCP restart.
- New stock object: `create_or_replace_object`. Afterwards run `inspect_project_properties_resources` with `list_all_resources`, delete the stray resources and move their files with `D:/game-jam-01-scratch/tools/cleanup-assets.py`.
- Change a property: `change_object_properties_effects` takes `changed_properties: [{property_name, new_value}]` — both keys required, and `new_value` is always a string, even for numbers and booleans (`"100"`, `"true"`).
- Terrain and scattered-model `Edits` are one JSON string: read it, append, write it back, never replace.
- Place new things (`put_3d_instances`): `brush_position_anchor` `bottom_center` for people and props, `min_corner` for Cube3D, `drop_to_surface` to rest on the ground. About 40 px per metre. `brush_kind` is required: `point`, `line`, `random_in_sphere`, `erase` or `none`. 3D `instances_size` is a string of three comma-separated numbers (`"100,200,150"`).
- Edit existing instances — this is how a terrain or scatter pass is done, never by creating copies:
  - get the ids from `describe_instances` (the `id` field), as a comma-separated string in `existing_instance_ids`;
  - move: `brush_kind: "point"` with those ids — `point` puts **every** listed instance on `brush_position`, so use one call per target position;
  - resize, rotate, hide, restack without moving: `brush_kind: "none"` (it never changes position);
  - delete: `brush_kind: "erase"` with the ids, or with only `object_name` to erase every instance of it on that layer. There is no separate remove tool.
- `put_2d_instances` is not the same shape as the 3D one: its anchors are `origin`, `min_corner` and `center` only (**no** `bottom_center`), and its brush kinds are `point`, `line`, `grid`, `random_in_circle`, `erase`, `none`.
- New events: fetch the EventScript guide with `docs`, then `read_full_docs` for each extension used, then `generate_events`. `extension_names_list` and `objects_list` are comma-separated strings, both required. On compile errors nothing is applied: fix the script and call again.
- Rework an existing event — do not append a duplicate of it. `read_events_source` with `event_ids` (or `search`), then `generate_events` with one `event_batches` entry carrying:
  - `placement_relation`: `replace_event_but_keep_existing_sub_events` (the usual one — do **not** include the sub-events in the script, they are re-attached automatically), `replace_entire_event_and_sub_events` (only when rewriting the whole subtree, which you must include in full), or `insert_after_sibling` / `insert_before_sibling` / `append_subevents_to` / `append_to_end` / `delete`;
  - `placement_target_event_id`: the id from `read_events_source`;
  - `expected_event_source`: required with a replace relation when you send `event_script` (not needed with `edits`) — the current source exactly as `read_events_source` returned it, without sub-events for the "keep" variant. It is a guard: a mismatch rejects the call and returns the current source;
  - `placement_rationale`: one sentence, required;
  - for a small change inside a long event, `edits: [{old_string, new_string, replace_all?}]` instead of `event_script`.

  At most 6 `event_batches` per call.
- Test: `run_gameplay_test` with `scope: {type: "project"}`, `test_name`, `source`, `persist: false` (otherwise it overwrites the stored test). Two screenshots at most, small width. Ask Ryan to confirm anything visual.
- `run_script` is the last resort, not a batching default: it needs `docs({what: "script_api"})` first, which is the largest doc there is (about 135 KB) and is charged on every request afterwards. The funnel already made single named calls cheap, so batch only when you need a loop or a branch, or when the steps depend on each other and five or more calls would otherwise be needed. A script stops at the first failed call with no rollback: everything before it stays applied.

## When a call fails

- Read the error. Fetch `docs({what: "schema", name})` for that function once, fix the arguments, call again.
- Never retry the same arguments. Never guess object names, resource names or extension names: read them.
- An `expected_event_source` mismatch is not a bug in the call shape: re-read the event and redo the edit against what it returned.
- Two failures in a row: stop and tell Ryan what failed and what was tried.
