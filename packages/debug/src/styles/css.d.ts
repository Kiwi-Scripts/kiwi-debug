// Stylesheets are inlined as strings at build time (tsup `loader: { '.css': 'text' }`).
declare module '*.css' {
    const css: string;
    export default css;
}
