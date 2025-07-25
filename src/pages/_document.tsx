import { Body } from '@/components/primitives/body'
import { Head, Html, Main, NextScript } from 'next/document'

export default function Document() {
	return (
		<Html lang="en" suppressHydrationWarning>
			<Head>
				<meta charSet="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<link rel="icon" href="/favicon.ico" />
			</Head>
			<Body>
				<Main />
				<NextScript />
			</Body>
		</Html>
	)
}
