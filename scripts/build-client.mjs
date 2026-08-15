import { build } from "esbuild";

await build({
  entryPoints: ["client/index.jsx"],
  bundle: true,
  format: "cjs",
  platform: "browser",
  external: ["react"],
  define: { "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production") },
  banner: { js: 'window.__ModuleLoader__.load({id:"dsh-codex-oauth",factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
  footer: { js: "return module.exports;}});" },
  outfile: "lib/client.js",
});
