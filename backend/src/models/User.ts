import mongoose, { Schema } from "mongoose";
import bcrypt from "bcryptjs";
import type { IUser } from "../types/index.js";
import { DISPLAY_CURRENCIES } from "../utils/currencies.js";

const userSchema = new Schema<IUser>(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
      maxlength: [100, "Name cannot exceed 100 characters"],
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      trim: true,
      lowercase: true,
      match: [/^\S+@\S+\.\S+$/, "Please provide a valid email"],
    },
    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: [8, "Password must be at least 8 characters"],
      select: false,
    },
    role: {
      type: Schema.Types.ObjectId,
      ref: "Role",
      required: [true, "Role is required"],
    },
    designation: {
      type: String,
      trim: true,
      maxlength: [100, "Designation cannot exceed 100 characters"],
    },
    extension: {
      type: String,
      trim: true,
      maxlength: [20, "Extension cannot exceed 20 characters"],
      default: null,
    },
    /* "manual": typed on the Users screen — the 3CX call sync never overwrites it.
       "3cx": filled from 3CX's users by email (services/callSyncService.ts). */
    extensionSource: {
      type: String,
      enum: ["manual", "3cx", null],
      default: null,
    },
    /**
     * The currency they see amounts in (Settings → Currency, 2026-10-15) — kept on their account, so it follows them
     * to every device they sign in on. null: never picked (the app's default, USD).
     */
    currency: { type: String, enum: [...DISPLAY_CURRENCIES, null], default: null },
    /** When that currency was picked — a pick saved late (the app was offline) never replaces a newer one. */
    currencyAt: { type: Date, default: null },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Hash password before save
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Compare passwords
userSchema.methods.comparePassword = async function (candidatePassword: string): Promise<boolean> {
  return bcrypt.compare(candidatePassword, this.password);
};

// Remove password from JSON output
userSchema.set("toJSON", {
  transform: (_doc, ret) => {
    delete ret.password;
    return ret;
  },
});

userSchema.index({ email: 1 });
userSchema.index({ role: 1 });
userSchema.index({ status: 1 });

export const User = mongoose.model<IUser>("User", userSchema);
