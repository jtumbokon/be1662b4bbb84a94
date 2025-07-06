export const UserRole = {
	admin: "admin",
	user: "user",
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

// User interface matching the database schema and session type
export interface User {
	id: string;
	name: string | null;
	email: string;
	emailVerified: Date | null;
	image: string | null;
	role?: UserRole;
	theme?: "light" | "dark" | "system";
	bio?: string | null;
	githubUsername?: string | null;
	vercelConnectionAttemptedAt?: Date | null;
	createdAt?: Date;
	updatedAt?: Date;
	metadata?: string | null;
	isGuest?: boolean;
	accounts?: {
		provider: string;
		providerAccountId: string;
	}[];
	payloadToken?: string;
}

// Session interface that matches NextAuth session type
export interface Session {
	user: {
		id: string;
		name: string | null;
		email: string | null; // NextAuth allows null email
		image: string | null;
		bio: string | null;
		githubUsername: string | null;
		theme?: "light" | "dark" | "system";
		emailVerified: Date | null;
		vercelConnectionAttemptedAt?: Date | null;
		isGuest?: boolean;
		accounts?: {
			provider: string;
			providerAccountId: string;
		}[];
		payloadToken?: string;
	};
	expires: string;
}

// Import NextAuth Session type
import type { Session as NextAuthSession } from "next-auth";

// Type guard to check if auth() returned a Session vs NextResponse
export function isSession(
	sessionOrResponse: NextAuthSession | import("next/server").NextResponse<unknown> | null
): sessionOrResponse is NextAuthSession {
	return sessionOrResponse !== null && 'user' in sessionOrResponse && 'expires' in sessionOrResponse;
}
