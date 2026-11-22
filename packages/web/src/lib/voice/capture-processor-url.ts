/** The bundled worklet module's URL. Its own file so unit tests, which never start a real capture, do not load it. */
export { default } from "./capture-processor.ts?worker&url"
