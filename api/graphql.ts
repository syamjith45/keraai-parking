import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
// FIX: Using namespace import for express to resolve type conflicts with global Request/Response types.
import * as express from 'express';
import cors from 'cors';
import * as admin from 'firebase-admin';
import { BookingStatus, Vehicle, VehicleType } from '../src/types';

// --- Firebase Admin Initialization ---
// This now correctly uses the separate environment variables you've set in Vercel.
if (!admin.apps.length) {
  try {
    const serviceAccount = {
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Replace the escaped newlines in the private key
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    };
    
    if (!serviceAccount.projectId || !serviceAccount.clientEmail || !serviceAccount.privateKey) {
        throw new Error("Firebase environment variables are not set.");
    }

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  } catch (error: any) {
    console.error('Firebase admin initialization error:', error.message);
  }
}
const adminDb = admin.firestore();
const adminAuth = admin.auth();

// --- Helper function to get all auth users with pagination ---
const getAllAuthUsers = async (): Promise<admin.auth.UserRecord[]> => {
    const allUsers: admin.auth.UserRecord[] = [];
    let pageToken: string | undefined;

    do {
        const listUsersResult = await adminAuth.listUsers(1000, pageToken);
        allUsers.push(...listUsersResult.users);
        pageToken = listUsersResult.pageToken;
    } while (pageToken);

    return allUsers;
};


// --- GraphQL Schema Definition ---
const typeDefs = `#graphql
  enum Role {
    customer
    operator
    admin
  }

  enum VehicleType {
    TWO_WHEELER
    FOUR_WHEELER
    SUV
  }

  type Vehicle {
    registrationNumber: String!
    type: VehicleType!
  }

  input VehicleInput {
    registrationNumber: String!
    type: VehicleType!
  }

  type User {
    uid: ID!
    name: String
    email: String!
    vehicles: [Vehicle!]
    role: Role!
  }

  type Coordinates {
    lat: Float!
    lng: Float!
  }

  type ParkingSlot {
      id: String!
      status: String!
  }

  type ParkingLot {
    id: ID!
    name: String!
    address: String!
    totalSlots: Int!
    availableSlots: Int!
    pricePerHour: Float!
    coords: Coordinates!
    slots: [ParkingSlot!]!
  }
  
  enum BookingStatus {
    Active
    Completed
    Cancelled
  }

  type ParkingLotInfo {
    name: String!
    address: String!
  }

  type Booking {
    id: ID!
    userId: String!
    lotId: String!
    parkingLotInfo: ParkingLotInfo!
    slotNumber: String!
    startTime: String!
    endTime: String!
    durationHours: Int!
    totalAmount: Float!
    status: BookingStatus!
  }

  type AdminStats {
    totalUsers: Int!
    totalLots: Int!
    activeBookings: Int!
    completedBookings: Int!
  }

  type VerifyBookingResponse {
      success: Boolean!
      message: String!
      details: String
  }

  type Query {
    me: User
    parkingLots: [ParkingLot!]!
    myBookings: [Booking!]!
    allUsers: [User!]!
    adminStats: AdminStats!
  }

  type Mutation {
    setupProfile(name: String!, vehicle: VehicleInput!): User!
    addParkingLot(name: String!, address: String!, totalSlots: Int!, pricePerHour: Float!, lat: Float!, lng: Float!, slotPrefix: String!): ParkingLot!
    createBooking(lotId: ID!, slot: String!, duration: Int!): Booking!
    verifyBooking(bookingId: ID!): VerifyBookingResponse!
    updateUserRole(uid: ID!, role: Role!): User!
  }
`;

// --- Type for our Context ---
interface ContextValue {
    user?: {
        uid: string;
        role: string;
    }
}

// --- GraphQL Resolvers ---
const resolvers = {
    Query: {
        me: async (_: any, __: any, context: ContextValue) => {
            if (!context.user) throw new Error("Unauthorized");
            const doc = await adminDb.collection('users').doc(context.user.uid).get();
            if (!doc.exists) return null;
            // Add uid to the returned data, as it's the doc id.
            return { uid: doc.id, ...doc.data() };
        },
        parkingLots: async (_: any, __: any, context: ContextValue) => {
            if (!context.user) throw new Error("Unauthorized");
            const snapshot = await adminDb.collection('parkingLots').get();
            return snapshot.docs.map(doc => {
                const data = doc.data();
                const slots = Object.entries(data.slots || {}).map(([id, status]) => ({ id, status }));
                return { id: doc.id, ...data, slots };
            });
        },
        myBookings: async (_: any, __: any, context: ContextValue) => {
            if (!context.user) throw new Error("Unauthorized");
            const snapshot = await adminDb.collection('bookings').where('userId', '==', context.user.uid).orderBy('startTime', 'desc').get();
            return snapshot.docs.map(doc => {
                const data = doc.data();
                return {
                    id: doc.id,
                    ...data,
                    startTime: data.startTime.toDate().toISOString(),
                    endTime: data.endTime.toDate().toISOString(),
                };
            });
        },
        allUsers: async (_: any, __: any, context: ContextValue) => {
            if (context.user?.role !== 'admin') throw new Error("Forbidden: Admins only");
            
            const allAuthUsers = await getAllAuthUsers();
            
            const usersFromDb = await adminDb.collection('users').get();
            const dbDataByUid = new Map(usersFromDb.docs.map(doc => [doc.id, doc.data()]));

            return allAuthUsers.map(userRecord => {
                const dbUser = dbDataByUid.get(userRecord.uid) || {};
                return {
                  uid: userRecord.uid,
                  email: userRecord.email,
                  name: dbUser.name || 'N/A',
                  role: userRecord.customClaims?.role || 'customer',
                  vehicles: dbUser.vehicles || [],
                };
            });
        },
        adminStats: async (_: any, __: any, context: ContextValue) => {
            if (context.user?.role !== 'admin') throw new Error("Forbidden: Admins only");
            
            const allAuthUsers = await getAllAuthUsers();
            
            const [lots, active, completed] = await Promise.all([
                adminDb.collection('parkingLots').count().get().then(snap => snap.data().count),
                adminDb.collection('bookings').where('status', '==', BookingStatus.ACTIVE).count().get().then(snap => snap.data().count),
                adminDb.collection('bookings').where('status', '==', BookingStatus.COMPLETED).count().get().then(snap => snap.data().count),
            ]);
            return { totalUsers: allAuthUsers.length, totalLots: lots, activeBookings: active, completedBookings: completed };
        },
    },
    Mutation: {
        setupProfile: async (_: any, { name, vehicle }: { name: string, vehicle: Vehicle }, context: ContextValue) => {
            if (!context.user) throw new Error("Unauthorized");
            const userRef = adminDb.collection('users').doc(context.user.uid);
            
            // Atomically create the user document with initial role and profile info.
            await userRef.set({ 
                name, 
                vehicles: [vehicle], 
                role: 'customer', // Explicitly set role on profile setup
                email: (await adminAuth.getUser(context.user.uid)).email
            }, { merge: true });

            await adminAuth.setCustomUserClaims(context.user.uid, { role: 'customer' });

            const doc = await userRef.get();
            return { uid: context.user.uid, ...doc.data() };
        },
        addParkingLot: async (_: any, args: any, context: ContextValue) => {
             if (context.user?.role !== 'admin' && context.user?.role !== 'operator') throw new Error("Forbidden: Operators or Admins only");
            const { name, address, totalSlots, pricePerHour, lat, lng, slotPrefix } = args;
            const slotsMap: { [key: string]: "available" | "occupied" } = {};
            for (let i = 1; i <= totalSlots; i++) {
                slotsMap[`${slotPrefix}-${i}`] = "available";
            }
            const newLot = { name, address, totalSlots, pricePerHour, coords: { lat, lng }, availableSlots: totalSlots, slots: slotsMap };
            const docRef = await adminDb.collection('parkingLots').add(newLot);
            const slots = Object.entries(slotsMap).map(([id, status]) => ({ id, status }));
            return { id: docRef.id, ...newLot, slots };
        },
        createBooking: async (_: any, { lotId, slot, duration }: {lotId: string, slot: string, duration: number}, context: ContextValue) => {
            if (!context.user) throw new Error("Unauthorized");
            const lotRef = adminDb.collection('parkingLots').doc(lotId);
            const newBookingRef = adminDb.collection('bookings').doc();

            return await adminDb.runTransaction(async (t) => {
                const lotDoc = await t.get(lotRef);
                if (!lotDoc.exists) throw new Error("Parking lot not found.");
                const lotData = lotDoc.data()!;
                if (lotData.slots[slot] !== 'available') throw new Error("Slot is no longer available.");
                
                const startTime = new Date();
                const endTime = new Date(startTime.getTime() + duration * 3600 * 1000);

                const booking = {
                    userId: context.user!.uid, lotId, slotNumber: slot,
                    startTime: admin.firestore.Timestamp.fromDate(startTime),
                    endTime: admin.firestore.Timestamp.fromDate(endTime),
                    durationHours: duration,
                    totalAmount: lotData.pricePerHour * duration,
                    status: BookingStatus.ACTIVE,
                    parkingLotInfo: { name: lotData.name, address: lotData.address },
                };
                t.set(newBookingRef, booking);
                t.update(lotRef, { availableSlots: admin.firestore.FieldValue.increment(-1), [`slots.${slot}`]: 'occupied' });

                return { ...booking, id: newBookingRef.id, startTime: startTime.toISOString(), endTime: endTime.toISOString() };
            });
        },
        verifyBooking: async (_: any, { bookingId }: { bookingId: string }, context: ContextValue) => {
            if (context.user?.role !== 'admin' && context.user?.role !== 'operator') throw new Error("Forbidden: Operators or Admins only");
            const bookingRef = adminDb.collection('bookings').doc(bookingId);
            try {
                 let slotNumber = '';
                 await adminDb.runTransaction(async (t) => {
                    const bookingDoc = await t.get(bookingRef);
                    if (!bookingDoc.exists) throw new Error("Booking not found.");
                    const bookingData = bookingDoc.data()!;
                    if (bookingData.status !== BookingStatus.ACTIVE) throw new Error(`Booking is already ${bookingData.status}.`);
                    
                    slotNumber = bookingData.slotNumber;
                    t.update(bookingRef, { status: BookingStatus.COMPLETED });
                    const lotRef = adminDb.collection('parkingLots').doc(bookingData.lotId);
                    t.update(lotRef, { availableSlots: admin.firestore.FieldValue.increment(1), [`slots.${bookingData.slotNumber}`]: 'available' });
                });
                return { success: true, message: "Check-Out Successful!", details: `Slot ${slotNumber} is now free.` };
            } catch (error: any) {
                return { success: false, message: "Verification Failed", details: error.message };
            }
        },
        updateUserRole: async (_: any, { uid, role }: {uid: string, role: string}, context: ContextValue) => {
            if (context.user?.role !== 'admin') throw new Error("Forbidden: Admins only");
            if (!['customer', 'operator', 'admin'].includes(role)) throw new Error("Invalid role specified.");

            await adminAuth.setCustomUserClaims(uid, { role });
            const userRef = adminDb.collection('users').doc(uid);
            await userRef.update({ role });
            
            const doc = await userRef.get();
            return { uid, ...doc.data() };
        }
    }
};


// --- Apollo Server Setup with Express ---

const server = new ApolloServer<ContextValue>({
  typeDefs,
  resolvers,
});

server.startInBackgroundHandlingStartupErrorsByLoggingAndFailingAllRequests();
const app = express();

// FIX: Change Request to express.Request to avoid type conflicts and fix related errors.
const createContext = async ({ req }: { req: express.Request }): Promise<ContextValue> => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split('Bearer ')[1];
        try {
            const decodedToken = await adminAuth.verifyIdToken(token);
            return { user: { uid: decodedToken.uid, role: (decodedToken.role as string) || 'customer' } };
        } catch (error) {
            console.warn('Invalid auth token:', error);
            return {};
        }
    }
    return {};
};

// Vercel exports a handler function as the default export
// FIX: Change Request and Response to express.Request and express.Response to fix type errors.
export default async function handler(req: express.Request, res: express.Response) {
    const middleware = expressMiddleware(server, {
        context: createContext,
    });
    
    // Setup CORS and JSON parsing, then run the Apollo middleware.
    // This structure is required for Vercel's serverless environment.
    cors<cors.CorsRequest>()(req, res, () => {
        express.json()(req, res, () => {
            middleware(req, res, (err) => {
                if (err) {
                    console.error('Middleware error:', err);
                    res.status(500).send('Internal Server Error');
                }
            });
        });
    });
}
