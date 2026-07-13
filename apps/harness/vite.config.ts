import { tanstackRouter } from "@tanstack/router-plugin/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const graphqlProxy = {
  "/graphql": {
    target: "http://127.0.0.1:3001",
    changeOrigin: true,
  },
}

export default defineConfig({
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    react(),
  ],
  server: {
    port: 4200,
    proxy: graphqlProxy,
  },
  preview: {
    port: 4200,
    proxy: graphqlProxy,
  },
})
