declare module 'react-syntax-highlighter' {
  import { ComponentType, ReactNode } from 'react'
  interface SyntaxHighlighterProps {
    language?: string
    style?: Record<string, unknown>
    children?: ReactNode
    [key: string]: unknown
  }
  export const Prism: ComponentType<SyntaxHighlighterProps>
  const SyntaxHighlighter: ComponentType<SyntaxHighlighterProps>
  export default SyntaxHighlighter
}

declare module 'react-syntax-highlighter/dist/esm/styles/prism' {
  import { CSSProperties } from 'react'
  export const oneDark: Record<string, CSSProperties>
  export const oneLight: Record<string, CSSProperties>
}
