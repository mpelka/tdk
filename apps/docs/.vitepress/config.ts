import { defineConfig } from "vitepress";

// VitePress site config for the TDK docs.
export default defineConfig({
  title: "TDK",
  description: "Template Development Kit — author Backstage Scaffolder templates as typed, testable TypeScript.",
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Reference", link: "/reference/cli" },
    ],
    sidebar: [
      {
        text: "Introduction",
        items: [
          { text: "What is TDK?", link: "/" },
          { text: "Get started", link: "/guide/getting-started" },
          { text: "Core concepts", link: "/guide/concepts" },
        ],
      },
      {
        text: "Guide",
        items: [
          { text: "Author a template", link: "/guide/authoring" },
          { text: "Write expressions", link: "/guide/expressions" },
          { text: "Test templates", link: "/guide/testing" },
          { text: "Port a YAML template", link: "/guide/porting" },
          { text: "Migrate a fleet", link: "/guide/migrating" },
          { text: "Cookbook", link: "/guide/cookbook" },
          { text: "Extend TDK", link: "/guide/extending" },
          { text: "The VS Code extension", link: "/guide/vscode" },
          { text: "Stability contract", link: "/guide/stability" },
          { text: "Design decisions", link: "/guide/decisions" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "CLI", link: "/reference/cli" },
          { text: "Expression support", link: "/reference/expression-support" },
        ],
      },
    ],
  },
});
