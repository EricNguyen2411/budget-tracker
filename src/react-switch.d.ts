import 'react'

declare module 'react' {
  interface InputHTMLAttributes<T> {
    switch?: boolean
  }
}
