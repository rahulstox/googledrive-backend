import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { Strategy as GitHubStrategy } from "passport-github2";
import User from "../models/User.js";

const setupPassport = () => {
  // Google Strategy
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use(
      new GoogleStrategy(
        {
          clientID: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          callbackURL: "/api/auth/google/callback",
          proxy: true,
        },
        async (accessToken, refreshToken, profile, done) => {
          try {
            // Check if user exists
            let user = await User.findOne({
              $or: [{ googleId: profile.id }, { email: profile.emails[0].value }],
            });

            if (user) {
              // If user exists but no googleId, link it
              if (!user.googleId) {
                user.googleId = profile.id;
                user.authProvider = "google"; // Update primary provider or keep email?
                if (!user.firstName || user.firstName === "User") {
                  user.firstName = profile.name?.givenName || "User";
                  user.lastName = profile.name?.familyName || "";
                }
                await user.save();
              }
              return done(null, user);
            }

            // Create new user
            user = await User.create({
              firstName: profile.name?.givenName || "User",
              lastName: profile.name?.familyName || "",
              email: profile.emails[0].value,
              googleId: profile.id,
              authProvider: "google",
              isActive: true, // Auto-activate OAuth users
            });

            done(null, user);
          } catch (err) {
            console.error("Google Auth Error:", err);
            done(err, null);
          }
        }
      )
    );
  } else {
    console.warn("Skipping Google OAuth setup - Missing GOOGLE_CLIENT_ID/SECRET");
  }

  // GitHub Strategy
  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
    passport.use(
      new GitHubStrategy(
        {
          clientID: process.env.GITHUB_CLIENT_ID,
          clientSecret: process.env.GITHUB_CLIENT_SECRET,
          callbackURL: "/api/auth/github/callback",
          proxy: true,
        },
        async (accessToken, refreshToken, profile, done) => {
          try {
            const email = profile.emails?.[0]?.value || null;
            
            if (!email) {
               return done(new Error("No email found in GitHub profile"), null);
            }

            let user = await User.findOne({
              $or: [{ githubId: profile.id }, { email: email }],
            });

            if (user) {
              if (!user.githubId) {
                user.githubId = profile.id;
                await user.save();
              }
              return done(null, user);
            }

            // Parse name
            const nameParts = (profile.displayName || profile.username || "User").split(" ");
            const firstName = nameParts[0];
            const lastName = nameParts.slice(1).join(" ") || "";

            user = await User.create({
              firstName,
              lastName,
              email: email,
              githubId: profile.id,
              authProvider: "github",
              isActive: true,
            });

            done(null, user);
          } catch (err) {
            console.error("GitHub Auth Error:", err);
            done(err, null);
          }
        }
      )
    );
  } else {
    console.warn("Skipping GitHub OAuth setup - Missing GITHUB_CLIENT_ID/SECRET");
  }

  // Serialization (Not needed for session: false, but good practice if sessions enabled later)
  passport.serializeUser((user, done) => {
    done(null, user.id);
  });

  passport.deserializeUser(async (id, done) => {
    try {
      const user = await User.findById(id);
      done(null, user);
    } catch (err) {
      done(err, null);
    }
  });
};

export default setupPassport;
