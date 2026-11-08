// Trimmed excerpt of the `run_script` API that the GDevelop editor ships as
// script-api.d.ts, kept small on purpose: the funnel serves this file only so
// the tests can exercise the `docs({what:"script_api"})` resource path without
// a GDevelop install. The real file is about 135 KB.
//
// Regenerate the full pair with:
//   GDEVELOP_SOURCE_DIR=<GDevelop checkout> node test-funnel.js

declare namespace gdjs {
  interface RuntimeScene {
    readonly name: string;
    getObjects(name: string): gdjs.RuntimeObject[];
    getVariables(): gdjs.VariablesContainer;
    setBackgroundColor(r: number, g: number, b: number): void;
  }

  interface RuntimeObject {
    readonly name: string;
    getX(): number;
    getY(): number;
    setX(x: number): void;
    setY(y: number): void;
    getVariables(): gdjs.VariablesContainer;
    deleteFromScene(): void;
  }

  interface VariablesContainer {
    get(name: string): gdjs.Variable;
    has(name: string): boolean;
    add(name: string): gdjs.Variable;
  }

  interface Variable {
    getAsNumber(): number;
    getAsString(): string;
    setNumber(value: number): void;
    setString(value: string): void;
    isStructure(): boolean;
    isArray(): boolean;
  }

  interface RuntimeGame {
    getSceneStack(): gdjs.SceneStack;
    getVariables(): gdjs.VariablesContainer;
  }

  interface SceneStack {
    pushScene(sceneName: string): void;
    popScene(): void;
    replaceScene(sceneName: string): void;
  }
}
