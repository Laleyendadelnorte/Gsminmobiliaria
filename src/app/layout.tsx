import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata={title:'GCM · Private Property Experience',description:'Espacio privado de gestión inmobiliaria',robots:{index:false,follow:false}};
export default function RootLayout({children}:{children:React.ReactNode}) {return <html lang="es-DO"><body>{children}</body></html>}
