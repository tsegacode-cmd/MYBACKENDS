import express from 'express';
import { authenticate, authorize } from '../middleware/auth.js';
import {
  createPost,
  deletePost,
  createStory,
  createPostComment,
  createStoryComment,
  createDeposit,
  createWithdrawal,
  followPerson,
  getRootMessageConversation,
  getRootMessageUsers,
  getRootUserThreads,
  getRootFeedManagement,
  moderateRootPost,
  reportPost,
  updateRootPostReport,
  getSupportPresence,
  updatePresence,
  getFeed,
  getPostComments,
  getStories,
  getStoryComments,
  getFriends,
  getInbox,
  getMessages,
  getMyReferralCode,
  getNotifications,
  getPeople,
  getPersonProfile,
  getWallet,
  likePost,
  likeStory,
  markNotificationsRead,
  repostPost,
  requestFriend,
  respondFriendRequest,
  sendMessage,
  sendRootMessage,
  sharePost,
  shareStory,
  unfollowPerson,
} from '../controllers/socialController.js';
import { getMyBoostRequests, requestPostBoost } from '../controllers/marketplaceController.js';

const router = express.Router();
router.use(authenticate);

router.get('/feed', getFeed);
router.get('/admin/feed-moderation', authorize('root', 'admin', 'Root', 'Admin'), getRootFeedManagement);
router.patch('/admin/posts/:postId/moderation', authorize('root', 'admin', 'Root', 'Admin'), moderateRootPost);
router.patch('/admin/reports/:reportId', authorize('root', 'admin', 'Root', 'Admin'), updateRootPostReport);
router.post('/posts', createPost);
router.post('/posts/:postId/reports', reportPost);
router.delete('/posts/:postId', deletePost);
router.post('/posts/:postId/like', likePost);
router.get('/posts/:postId/comments', getPostComments);
router.post('/posts/:postId/comments', createPostComment);
router.post('/posts/:postId/share', sharePost);
router.post('/posts/:postId/repost', repostPost);
router.post('/boost-requests', requestPostBoost);
router.get('/boost-requests', getMyBoostRequests);
router.get('/stories', getStories);
router.post('/stories', createStory);
router.post('/stories/:storyId/like', likeStory);
router.get('/stories/:storyId/comments', getStoryComments);
router.post('/stories/:storyId/comments', createStoryComment);
router.post('/stories/:storyId/share', shareStory);

router.get('/people', getPeople);
router.get('/people/:userId', getPersonProfile);
router.post('/presence/heartbeat', updatePresence);
router.get('/support/presence', getSupportPresence);
router.get('/friends', getFriends);
router.post('/friends/:userId/request', requestFriend);
router.patch('/friends/requests/:requestId', respondFriendRequest);
router.post('/follows/:userId', followPerson);
router.delete('/follows/:userId', unfollowPerson);

router.get('/messages', getInbox);
router.get('/messages/conversation', getMessages);
router.post('/messages', sendMessage);
router.get('/admin/messages/users', authorize('root', 'admin', 'Root', 'Admin'), getRootMessageUsers);
router.get('/admin/messages/threads/:userId', authorize('root', 'admin', 'Root', 'Admin'), getRootUserThreads);
router.get('/admin/messages/conversation', authorize('root', 'admin', 'Root', 'Admin'), getRootMessageConversation);
router.post('/admin/messages', authorize('root', 'admin', 'Root', 'Admin'), sendRootMessage);
router.get('/notifications', getNotifications);
router.post('/notifications/read', markNotificationsRead);

router.get('/wallet', getWallet);
router.post('/wallet/deposits', createDeposit);
router.post('/wallet/withdrawals', createWithdrawal);
router.get('/referral-code', getMyReferralCode);

export default router;
