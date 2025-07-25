import type { UserRole } from "@/types/user";
import "next-auth";

declare module "next-auth" {
	interface Session {
		user: {
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
		};
	}

	// interface User {
	// 	id: string;
	// 	name: string | null;
	// 	email: string;
	// 	emailVerified: Date | null;
	// 	image: string | null;
	// 	role?: UserRole;
	// 	theme?: "light" | "dark" | "system";
	// 	bio?: string | null;
	// 	githubUsername?: string | null;
	// }
}
