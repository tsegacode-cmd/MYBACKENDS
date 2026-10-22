import express from 'express';
import { authenticate, authorize } from '../middleware/auth.js';
import {
  createPost,
  deletePost,
  deleteMessage,
  createStory,
  createPostComment,
  createStoryComment,
  createDeposit,
  createCoinSavings,
  createWithdrawal,
  convertCoinsToEtb,
  convertEtbToCoins,
  followPerson,
  getRootMessageConversation,
  getRootMessageUsers,
  getRootUserThreads,
  deleteRootMessage,
  getRootFeedManagement,
  getRootStories,
  moderateRootPost,
  removeRootStory,
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
  getSocialUnreadCounts,
  getMessages,
  getMyReferralCode,
  getMyWalletActivity,
  getNotifications,
  getPeople,
  getPersonProfile,
  getWallet,
  getMyCoinLevel,
  convertBonusToReal,
  likePost,
  likeStory,
  markNotificationsRead,
  repostPost,
  requestFriend,
  respondFriendRequest,
  sendMessage,
  sendCoinGift,
  sendRootMessage,
  updateMessage,
  forwardMessage,
  sharePost,
  shareStory,
  unfollowPerson,
} from '../controllers/socialController.js';
import { getMyBoostRequests, requestPostBoost } from '../controllers/marketplaceController.js';
import {
  claimLinkCampaignReward,
  createLinkCampaign,
  getLinkCampaigns,
  progressLinkCampaignView,
  startLinkCampaignView,
} from '../controllers/linkCampaignController.js';
import { getDailyGameRewards, playDailyRewardGame } from '../controllers/dailyGameRewardController.js';
import { claimPromoCode, getActivePromoCodes } from '../controllers/promoCodeController.js';

const router = express.Router();
router.use(authenticate);

router.get('/feed', getFeed);
router.get('/admin/feed-moderation', authorize('root', 'admin', 'Root', 'Admin'), getRootFeedManagement);
router.get('/admin/stories', authorize('root', 'admin', 'Root', 'Admin'), getRootStories);
router.delete('/admin/stories/:storyId', authorize('root', 'admin', 'Root', 'Admin'), removeRootStory);
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
router.get('/link-campaigns', getLinkCampaigns);
router.get('/daily-game-rewards', getDailyGameRewards);
router.post('/daily-game-rewards/:gameId/play', playDailyRewardGame);
router.get('/promo-codes', getActivePromoCodes);
router.post('/promo-codes/claim', claimPromoCode);
router.post('/link-campaigns', createLinkCampaign);
router.post('/link-campaigns/:campaignId/views', startLinkCampaignView);
router.post('/link-campaign-views/:viewId/progress', progressLinkCampaignView);
router.post('/link-campaign-views/:viewId/claim', claimLinkCampaignReward);
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
router.get('/unread-counts', getSocialUnreadCounts);
router.get('/messages/conversation', getMessages);
router.post('/messages', sendMessage);
router.patch('/messages/:messageId', updateMessage);
router.delete('/messages/:messageId', deleteMessage);
router.post('/messages/:messageId/forward', forwardMessage);
router.get('/admin/messages/users', authorize('root', 'admin', 'Root', 'Admin'), getRootMessageUsers);
router.get('/admin/messages/threads/:userId', authorize('root', 'admin', 'Root', 'Admin'), getRootUserThreads);
router.get('/admin/messages/conversation', authorize('root', 'admin', 'Root', 'Admin'), getRootMessageConversation);
router.post('/admin/messages', authorize('root', 'admin', 'Root', 'Admin'), sendRootMessage);
router.delete('/admin/messages/:messageId', authorize('root', 'admin', 'Root', 'Admin'), deleteRootMessage);
router.get('/notifications', getNotifications);
router.post('/notifications/read', markNotificationsRead);

router.get('/wallet', getWallet);
router.get('/wallet/coin-level', getMyCoinLevel);
router.get('/wallet/activity', getMyWalletActivity);
router.post('/wallet/coins/savings', createCoinSavings);
router.post('/wallet/deposits', createDeposit);
router.post('/wallet/withdrawals', createWithdrawal);
router.post('/wallet/bonus/convert', convertBonusToReal);
router.post('/wallet/coins/convert', convertCoinsToEtb);
router.post('/wallet/coins/buy', convertEtbToCoins);
router.post('/wallet/coins/gifts', sendCoinGift);
router.get('/referral-code', getMyReferralCode);

export default router;
