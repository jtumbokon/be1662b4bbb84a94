import { routes } from "@/config/routes";
import { SEARCH_PARAM_KEYS } from "@/config/search-param-keys";
import { STATUS_CODES } from "@/config/status-codes";
import { isPayloadEnabled } from "@/lib/payload/is-payload-enabled";
import { getPayloadClient } from "@/lib/payload/payload";
import { signInSchema } from "@/lib/schemas/auth";
import { signIn, signOut } from "@/server/auth";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";
import { userService } from "@/server/services/user-service";
import type { User, UserRole } from "@/types/user";
import { eq } from "drizzle-orm";
import crypto from "node:crypto";
import { promisify } from "node:util";
import "server-only";

// Define a simplified type for Payload User to avoid import issues
interface PayloadUser {
	id: string | number;
	email: string;
	[key: string]: unknown;
}

interface AuthOptions {
	redirectTo?: string;
	redirect?: boolean;
	protect?: boolean;
	role?: UserRole;
	nextUrl?: string;
	errorCode?: string;
	email?: string;
}

// Constants for password hashing
const SALT_LENGTH = 32;
const KEY_LENGTH = 64;
const SCRYPT_OPTIONS = {
	N: 16384, // CPU/memory cost parameter
	r: 8, // Block size parameter
	p: 1, // Parallelization parameter
} as const;

// Promisify scrypt
const scrypt = promisify<string | Buffer, Buffer, number, crypto.ScryptOptions, Buffer>(
	crypto.scrypt
);

/**
 * Hash a password using scrypt
 * @param password The plain text password to hash
 * @returns A string containing the salt and hash, separated by a colon
 */
async function hashPassword(password: string): Promise<string> {
	const salt = crypto.randomBytes(SALT_LENGTH);
	const derivedKey = await scrypt(password, salt, KEY_LENGTH, SCRYPT_OPTIONS);
	return `${salt.toString("hex")}:${derivedKey.toString("hex")}`;
}

/**
 * Verify a password against a hash
 * @param password The plain text password to verify
 * @param hash The hash to verify against (in format salt:hash)
 * @returns True if the password matches, false otherwise
 */
async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
	try {
		const parts = storedHash.split(":");
		if (parts.length !== 2) return false;

		// Explicitly type the parts to ensure they are strings
		const saltHex: string = parts[0];
		const hashHex: string = parts[1];

		// Create buffers from the hex strings
		const salt = Buffer.from(saltHex, "hex");
		const hash = Buffer.from(hashHex, "hex");

		const derivedKey = await scrypt(password, salt, KEY_LENGTH, SCRYPT_OPTIONS);
		return crypto.timingSafeEqual(hash, derivedKey);
	} catch {
		return false;
	}
}

/**
 * Authentication service for handling user authentication and authorization
 *
 * This service ensures synchronization between Payload CMS and Shipkit databases
 * for user-related operations (create, update, delete).
 */
export const AuthService = {
	/**
	 * Generate a consistent ID for use in both Payload CMS and Shipkit databases
	 * @returns A UUID string
	 */
	generateConsistentId(): string {
		return crypto.randomUUID();
	},

	/**
	 * Ensure a user exists in both Payload CMS and Shipkit databases
	 * @param userData User data to ensure exists in both databases
	 * @returns The user object if successful
	 */
	async ensureUserSynchronized(userData: {
		id: string;
		email: string;
		name?: string | null;
		image?: string | null;
	}): Promise<{ id: string; email: string }> {
		const { id, email, name, image } = userData;

		try {
			// Get Payload client
			const payload = await getPayloadClient();

			// Check if user exists in Payload CMS
			let payloadUser: PayloadUser | null = null;

			if (payload) {
				try {
					payloadUser = (await payload.findByID({
						collection: "users",
						id,
					})) as unknown as PayloadUser;
				} catch (error) {
					// User doesn't exist in Payload CMS
					console.debug(`User ${id} not found in Payload CMS, will create`);
				}
			} else {
				console.debug("Payload CMS is not available, proceeding without it");
			}

			// Create user in Payload CMS if not exists
			if (!payloadUser && payload) {
				try {
					payloadUser = (await payload.create({
						collection: "users",
						data: {
							// For Payload, we need to handle both string and number IDs
							// Some Payload configurations might expect number IDs
							id: id as any, // Use type assertion to bypass type checking
							email,
							// Generate a random password that won't be used
							// User will need to use "forgot password" to set a real password
							password: crypto.randomBytes(16).toString("hex"),
						},
					})) as unknown as PayloadUser;
					console.log(`Created user ${id} in Payload CMS`);
				} catch (error) {
					console.error(`Failed to create user ${id} in Payload CMS:`, error);
					throw new Error("Failed to create user in Payload CMS");
				}
			}

			// Ensure user exists in Shipkit database
			await userService.ensureUserExists({
				id,
				email,
				name: name || email,
				image,
			});
			// console.log(`Ensured user ${id} exists in Shipkit database`);

			return { id, email };
		} catch (error) {
			console.error("Error synchronizing user:", error);
			// Attempt cleanup if partial creation occurred
			await this.cleanupPartialUserCreation(id);
			throw error;
		}
	},

	/**
	 * Clean up a partially created user if synchronization fails
	 * @param userId The ID of the user to clean up
	 */
	async cleanupPartialUserCreation(userId: string): Promise<void> {
		try {
			// Get Payload client
			const payload = await getPayloadClient();

			// Try to delete from Payload CMS
			if (payload) {
				try {
					await payload.delete({
						collection: "users",
						id: userId,
					});
					console.debug(`Cleaned up user ${userId} from Payload CMS`);
				} catch (error) {
					// Ignore if user doesn't exist
					console.debug(`User ${userId} not found in Payload CMS during cleanup`);
				}
			}

			// Try to delete from Shipkit
			try {
				if (db) {
					await db.delete(users).where(eq(users.id, userId));
					// console.log(`Cleaned up user ${userId} from Shipkit database`);
				}
			} catch (error) {
				// Ignore if user doesn't exist
				if (!(error instanceof Error && error.message.includes("Record to delete not found"))) {
					console.warn(`Error cleaning up user ${userId} from Shipkit database:`, error);
				} else {
					console.debug(`User ${userId} not found in Shipkit database during cleanup`);
				}
			}
		} catch (error) {
			console.error(`Error during cleanup for user ${userId}:`, error);
		}
	},

	/**
	 * Update a user in both Payload CMS and Shipkit databases
	 * @param userId The ID of the user to update
	 * @param userData The user data to update
	 * @returns The updated user object
	 */
	async updateUserSynchronized(
		userId: string,
		userData: {
			email?: string;
			name?: string;
			image?: string;
		}
	): Promise<{ id: string; email?: string }> {
		try {
			// Update in Payload CMS
			const payloadUpdateData: Record<string, any> = {};
			if (userData.email) payloadUpdateData.email = userData.email;

			const payload = await getPayloadClient();
			if (Object.keys(payloadUpdateData).length > 0 && payload) {
				try {
					await payload.update({
						collection: "users",
						id: userId,
						data: payloadUpdateData,
					});
					// console.log(`Updated user ${userId} in Payload CMS`);
				} catch (payloadError) {
					console.warn("Failed to update user in Payload:", payloadError);
				}
			}

			// Update in Shipkit
			const shipkitUpdateData: Record<string, any> = {};
			if (userData.email) shipkitUpdateData.email = userData.email;
			if (userData.name) shipkitUpdateData.name = userData.name;
			if (userData.image) shipkitUpdateData.image = userData.image;

			if (Object.keys(shipkitUpdateData).length > 0 && db) {
				try {
					await db
						.update(users)
						.set({
							...shipkitUpdateData,
							updatedAt: new Date(),
						})
						.where(eq(users.id, userId));
					// console.log(`Updated user ${userId} in Shipkit database`);
				} catch (error) {
					console.error(`Failed to update user ${userId} in Shipkit database:`, error);
					throw new Error("Failed to update user in Shipkit database");
				}
			}

			return { id: userId, email: userData.email };
		} catch (error) {
			console.error(`Error updating user ${userId}:`, error);
			throw error;
		}
	},

	/**
	 * Delete a user from both Payload CMS and Shipkit databases
	 * @param userId The ID of the user to delete
	 */
	async deleteUserSynchronized(userId: string): Promise<void> {
		try {
			// Delete from Payload CMS
			// This should cascade to Shipkit due to the relationship defined in payload.config.ts
			const payload = await getPayloadClient();
			if (payload) {
				try {
					await payload.delete({
						collection: "users",
						id: userId,
					});
					// console.log(`Deleted user ${userId} from Payload CMS`);
				} catch (payloadError) {
					console.warn("Failed to delete user from Payload:", payloadError);
				}
			}

			// Verify deletion from Shipkit
			// This should happen automatically due to CASCADE, but we check to be sure
			if (db) {
				const shipkitUser = await db.query.users.findFirst({
					where: eq(users.id, userId),
				});

				if (shipkitUser) {
					console.warn(
						`User ${userId} still exists in Shipkit after Payload deletion, forcing delete`
					);
					await db.delete(users).where(eq(users.id, userId));
				}
			}

			// console.log(`Successfully deleted user ${userId} from both databases`);
		} catch (error) {
			console.error(`Error deleting user ${userId}:`, error);
			throw error;
		}
	},

	/**
	 * Sign in with OAuth provider
	 */
	async signInWithOAuth(providerId: string, options?: AuthOptions) {
		await signIn(
			providerId,
			{
				redirectTo: options?.redirectTo ?? routes.home,
				...options,
			},
			providerId === "resend" && options?.email
				? { email: options.email }
				: { prompt: "select_account" }
		);
		return { success: STATUS_CODES.LOGIN.message };
	},

	/**
	 * Sign in with email and password using Payload CMS
	 */
	async signInWithCredentials({
		email,
		password,
		redirect = true,
		redirectTo = routes.home,
	}: {
		email: string;
		password: string;
		redirect?: boolean;
		redirectTo?: string;
	}) {
		try {
			// First validate the credentials against Payload CMS
			// This will throw an error if the credentials are invalid
			const user = await this.validateCredentials({ email, password });

			if (!user) {
				throw new Error(STATUS_CODES.CREDENTIALS.message);
			}

			// Use NextAuth's signIn method with credentials provider
			// This will call the authorize function in the credentials provider
			// which uses our validateCredentials method that connects to Payload CMS
			return await signIn("credentials", {
				email,
				password,
				redirect, // Let NextAuth handle the redirect
				callbackUrl: redirectTo, // Use callbackUrl instead of redirectTo
			});
		} catch (error) {
			console.error("Error in signInWithCredentials:", error);
			throw error;
		}
	},

	/**
	 * Sign up with email and password using Payload CMS
	 * This method ensures the user is created in both Payload CMS and Shipkit databases
	 */
	async signUpWithCredentials({
		email,
		password,
		redirect = true,
		redirectTo = routes.home,
	}: {
		email: string;
		password: string;
		redirect?: boolean;
		redirectTo?: string;
	}) {
		try {
			if (!payload) {
				console.error("Payload CMS is not initialized");
				throw new Error("Authentication service unavailable");
			}

			// Check if user already exists in Payload CMS
			const existingUsers = await payload.find({
				collection: "users",
				where: {
					email: {
						equals: email,
					},
				},
			});

			if (existingUsers.docs.length > 0) {
				throw new Error("User already exists with this email");
			}

			// Generate a consistent ID for both databases
			const userId = this.generateConsistentId();
			// console.log(`Generated consistent ID ${userId} for new user`);

			// Create new user in Payload CMS with the consistent ID
			const newUser = await payload.create({
				collection: "users",
				data: {
					// For Payload, we need to handle both string and number IDs
					// Some Payload configurations might expect number IDs
					id: userId as any, // Use type assertion to bypass type checking
					email,
					password,
				},
			});

			if (!newUser) {
				throw new Error("Failed to create Payload CMS user");
			}

			console.debug(`Created user in Payload CMS with ID ${userId}`);

			// Create the user in the Shipkit database with the same ID
			await userService.ensureUserExists({
				id: userId, // Use the consistent ID
				email: newUser.email,
				name: newUser.email, // Use email as name initially
				image: null,
			});

			console.debug(`Created user in Shipkit database with ID ${userId}`);

			// Sign in the user and return the result directly
			return await signIn("credentials", {
				email,
				password,
				redirect,
				callbackUrl: redirectTo, // Use callbackUrl instead of redirectTo
			});
		} catch (error) {
			console.error("Sign up error:", error);
			// If we have a userId, attempt cleanup
			if (error instanceof Error && error.message.includes("ID")) {
				const match = error.message.match(/ID\s+(\S+)/);
				if (match?.[1]) {
					// Use optional chaining
					await this.cleanupPartialUserCreation(match[1]);
				}
			}
			throw error;
		}
	},

	/**
	 * Sign out the current user
	 */
	async signOut(options?: AuthOptions) {
		await signOut({
			redirectTo: `${routes.home}?${SEARCH_PARAM_KEYS.statusCode}=${STATUS_CODES.LOGOUT.code}`,
			redirect: true,
			...options,
		});

		return { success: STATUS_CODES.LOGOUT.message };
	},

	/**
	 * Update the NextAuth session with new data
	 * This is useful for keeping the NextAuth session in sync with Payload CMS
	 * @param options Options for updating the session
	 * @returns The updated session
	 */
	async updateSession({
		userId,
		data,
	}: {
		userId: string;
		data: Record<string, any>;
	}) {
		try {
			// Import the update function from auth.ts
			const { update } = await import("@/server/auth");

			// Update the session with the new data
			const updatedSession = await update({
				user: {
					id: userId,
					...data,
				},
			});

			console.debug(`Updated session for user ${userId} with new data`);
			return updatedSession;
		} catch (error) {
			console.error(`Error updating session for user ${userId}:`, error);
			throw error;
		}
	},

	/**
	 * Initiate the forgot password process
	 * @param email Email of the user who forgot their password
	 * @returns Success object or throws an error
	 */
	async forgotPassword(email: string): Promise<{ success: true }> {
		try {
			// Validate email exists in Payload CMS first
			if (!payload) {
				console.error("Payload CMS is not initialized");
				throw new Error("Authentication service unavailable");
			}

			// Check if the user exists in Payload CMS
			const existingUsers = await payload.find({
				collection: "users",
				where: {
					email: {
						equals: email,
					},
				},
			});

			if (existingUsers.docs.length === 0) {
				console.warn(`No user found with email: ${email}`);
				// Return success even when the email doesn't exist to prevent email enumeration
				return { success: true };
			}

			// Call Payload forgotPassword method
			await payload.forgotPassword({
				collection: "users",
				data: {
					email,
				},
			});

			console.debug(`Password reset email sent to ${email}`);
			return { success: true };
		} catch (error) {
			console.error("Error in forgotPassword:", error);
			throw error;
		}
	},

	/**
	 * Reset password using Payload CMS
	 * @param token Reset password token
	 * @param password New password
	 * @returns Success object or throws an error
	 */
	async resetPassword(token: string, password: string): Promise<{ success: true }> {
		try {
			if (!payload) {
				console.error("Payload CMS is not initialized");
				throw new Error("Authentication service unavailable");
			}

			// Call Payload resetPassword method
			await payload.resetPassword({
				collection: "users",
				data: {
					token,
					password,
				},
				overrideAccess: true,
			});

			// console.log("Password reset successful");
			return { success: true };
		} catch (error) {
			console.error("Error in resetPassword:", error);
			throw error;
		}
	},

	/**
	 * Validate user credentials against Payload CMS
	 * This method ensures the user exists in the Shipkit database after successful authentication
	 */
	async validateCredentials(credentials: unknown) {
		try {
			// Log the credentials for debugging (excluding password)
			if (credentials && typeof credentials === "object") {
				console.debug("Validating credentials:", {
					...(credentials as Record<string, unknown>),
					password: "[REDACTED]",
				});
			} else {
				console.debug("Invalid credentials format:", typeof credentials);
			}

			const parsedCredentials = signInSchema.safeParse(credentials);

			if (!parsedCredentials.success) {
				console.error("Validation error:", parsedCredentials.error);
				throw new Error(STATUS_CODES.CREDENTIALS.message);
			}

			const { email, password } = parsedCredentials.data;

			// Use Payload CMS for authentication
			if (!payload) {
				console.error("Payload CMS is not initialized");
				throw new Error(STATUS_CODES.AUTH_ERROR.message);
			}

			try {
				// First check if the user exists
				const existingUsers = await payload.find({
					collection: "users",
					where: {
						email: {
							equals: email,
						},
					},
				});

				if (existingUsers.docs.length === 0) {
					console.warn(`No user found with email: ${email}`);
					// Throw a specific error instead of returning null
					throw new Error(STATUS_CODES.CREDENTIALS.message);
				}

				// Attempt to login with Payload CMS
				try {
					const result = await payload.login({
						collection: "users",
						data: {
							email,
							password,
						},
					});

					if (!result?.user) {
						console.warn(`Invalid password for user: ${email}`);
						throw new Error(STATUS_CODES.CREDENTIALS.message);
					}

					// Create a user object to return to NextAuth
					const user = {
						id: String(result.user.id),
						name: result.user.email,
						email: result.user.email,
						emailVerified: null,
						image: null,
						payloadToken: result.token,
					};

					// Ensure the user exists in the Shipkit database
					await userService.ensureUserExists({
						id: user.id,
						email: user.email,
						name: user.name,
						image: user.image,
					});

					// console.log("User authenticated successfully:", user.id);
					return user;
				} catch (loginError) {
					console.warn(`Login failed for existing user: ${email}`, loginError);
					throw new Error(STATUS_CODES.CREDENTIALS.message);
				}
			} catch (error) {
				console.error("Authentication error:", error);
				// Re-throw the error if it's already a specific error message
				if (error instanceof Error && error.message === STATUS_CODES.CREDENTIALS.message) {
					throw error;
				}
				throw new Error(STATUS_CODES.AUTH_ERROR.message);
			}
		} catch (error) {
			console.error("Auth error:", error);
			// Re-throw the error instead of returning null
			throw error;
		}
	},

	async verifyEmail(token: string): Promise<{ success: boolean; message: string }> {
		if (!isPayloadEnabled()) {
			return { success: false, message: "Email verification not available" };
		}

		try {
			const payload = await getPayloadClient();
			if (!payload) {
				return { success: false, message: "Payload not available" };
			}

			// ... existing code ...
		} catch (error) {
			// ... existing code ...
		}
	},

	async resetPasswordViaCMS(
		token: string,
		password: string
	): Promise<{ success: boolean; message: string }> {
		if (!isPayloadEnabled()) {
			return { success: false, message: "Password reset not available" };
		}

		try {
			const payload = await getPayloadClient();
			if (!payload) {
				return { success: false, message: "Payload not available" };
			}

			// ... existing code ...
		} catch (error) {
			// ... existing code ...
		}
	},

	async updateUserProfile(
		userId: string,
		updates: Partial<User>
	): Promise<{ success: boolean; message?: string; user?: User }> {
		try {
			// ... existing code ...

			const payload = await getPayloadClient();
			if (Object.keys(payloadUpdateData).length > 0 && payload) {
				try {
					await payload.update({
						collection: "users",
						id: user.id,
						data: payloadUpdateData,
					});
				} catch (payloadError) {
					console.warn("Failed to update user in Payload:", payloadError);
				}
			}

			// ... existing code ...
		} catch (error) {
			// ... existing code ...
		}
	},

	async deleteUserAccount(userId: string): Promise<{ success: boolean; message?: string }> {
		try {
			// ... existing code ...

			const payload = await getPayloadClient();
			if (payload) {
				try {
					await payload.delete({
						collection: "users",
						id: userId,
					});
				} catch (payloadError) {
					console.warn("Failed to delete user from Payload:", payloadError);
				}
			}

			// ... existing code ...
		} catch (error) {
			// ... existing code ...
		}
	},

	async createUserViaCMS(userData: {
		email: string;
		password: string;
		name?: string;
	}): Promise<{ user?: any; error?: string }> {
		const payload = await getPayloadClient();
		if (!payload) {
			return { error: "Payload not available" };
		}

		try {
			// ... existing code ...

			const newUser = await payload.create({
				collection: "users",
				data: {
					email: userData.email,
					password: userData.password,
					name: userData.name || userData.email.split("@")[0],
					verified: false,
				},
			});

			// ... existing code ...
		} catch (error) {
			// ... existing code ...
		}
	},

	async forgotPasswordViaCMS(email: string): Promise<{ success: boolean; message: string }> {
		const payload = await getPayloadClient();
		if (!payload) {
			return { success: false, message: "Password reset not available" };
		}

		try {
			// ... existing code ...

			await payload.forgotPassword({
				collection: "users",
				data: { email },
			});

			// ... existing code ...
		} catch (error) {
			// ... existing code ...
		}
	},

	async resetPasswordViaCMS2(
		token: string,
		password: string
	): Promise<{ success: boolean; message: string }> {
		const payload = await getPayloadClient();
		if (!payload) {
			return { success: false, message: "Password reset not available" };
		}

		try {
			await payload.resetPassword({
				collection: "users",
				data: { token, password },
			});

			// ... existing code ...
		} catch (error) {
			// ... existing code ...
		}
	},

	async signInViaCMS(email: string, password: string): Promise<{ user?: any; error?: string }> {
		const payload = await getPayloadClient();
		if (!payload) {
			return { error: "Authentication not available" };
		}

		try {
			// Check if user exists first
			const existingUsers = await payload.find({
				collection: "users",
				where: { email: { equals: email } },
				limit: 1,
			});

			if (!existingUsers.docs.length) {
				return { error: "Invalid credentials" };
			}

			// If user exists, try to log in
			try {
				const result = await payload.login({
					collection: "users",
					data: { email, password },
				});

				// ... existing code ...
			} catch (loginError) {
				// ... existing code ...
			}
		} catch (error) {
			// ... existing code ...
		}
	},
} as const;
