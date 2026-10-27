-- REDSEA table creation script for Neon PostgreSQL SQL Editor.
-- Generated from redsea.db (69 SQLite tables, 56 SQLite indexes, plus 7 application runtime tables and 4 indexes).
-- Creates tables, indexes, and required compatibility columns only; it does not copy application records.
-- Run against a new, empty Neon database. Use the SQLite-to-Neon importer to migrate existing data.
BEGIN;

-- Table: agent_commission_records
CREATE TABLE IF NOT EXISTS agent_commission_records (
      commission_id TEXT PRIMARY KEY,
      agent_user_id TEXT NOT NULL,
      commission_type TEXT NOT NULL CHECK (commission_type IN ('fixed', 'movable')),
      client_name TEXT NOT NULL,
      client_phone TEXT NOT NULL DEFAULT '',
      asset_description TEXT NOT NULL,
      location TEXT NOT NULL DEFAULT '',
      amount DOUBLE PRECISION NOT NULL DEFAULT 0,
      commission_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
      commission_amount DOUBLE PRECISION NOT NULL CHECK (commission_amount >= 0),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'cancelled')),
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: agent_package_ledger
CREATE TABLE IF NOT EXISTS agent_package_ledger (
      entry_id TEXT PRIMARY KEY,
      agent_user_id TEXT NOT NULL,
      amount DOUBLE PRECISION NOT NULL,
      request_id TEXT,
      reference TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: agent_package_pool_ledger
CREATE TABLE IF NOT EXISTS agent_package_pool_ledger (
      entry_id TEXT PRIMARY KEY,
      amount DOUBLE PRECISION NOT NULL,
      agent_user_id TEXT,
      reference TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: agent_package_requests
CREATE TABLE IF NOT EXISTS agent_package_requests (
      request_id TEXT PRIMARY KEY,
      agent_user_id TEXT NOT NULL,
      amount DOUBLE PRECISION NOT NULL CHECK (amount > 0),
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      reviewed_by TEXT,
      reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: agent_product_history
CREATE TABLE IF NOT EXISTS agent_product_history (
      history_id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      agent_user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: agent_products
CREATE TABLE IF NOT EXISTS agent_products (
      product_id TEXT PRIMARY KEY,
      agent_user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price DOUBLE PRECISION NOT NULL CHECK (price > 0),
      status TEXT NOT NULL DEFAULT 'selling' CHECK (status IN ('selling', 'buying', 'sold', 'bought')),
      approval_status TEXT NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending', 'approved', 'rejected')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: agent_settings
CREATE TABLE IF NOT EXISTS agent_settings (
      agent_user_id TEXT PRIMARY KEY,
      service_charge_percent DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (service_charge_percent >= 0 AND service_charge_percent <= 100),
      reward_percent DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (reward_percent >= 0 AND reward_percent <= 100),
      payment_details TEXT NOT NULL DEFAULT '',
      updated_by TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: agent_wallet_requests
CREATE TABLE IF NOT EXISTS agent_wallet_requests (
      request_id TEXT PRIMARY KEY,
      agent_user_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      request_type TEXT NOT NULL CHECK (request_type IN ('deposit', 'withdrawal')),
      amount DOUBLE PRECISION NOT NULL CHECK (amount > 0),
      net_amount DOUBLE PRECISION NOT NULL CHECK (net_amount >= 0),
      service_charge DOUBLE PRECISION NOT NULL DEFAULT 0,
      agent_reward DOUBLE PRECISION NOT NULL DEFAULT 0,
      payment_method TEXT NOT NULL DEFAULT '',
      payment_reference TEXT NOT NULL DEFAULT '',
      payout_details TEXT NOT NULL DEFAULT '',
      receipt_image TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      reviewed_by TEXT,
      reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: boost_requests
CREATE TABLE IF NOT EXISTS boost_requests (
      request_id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      amount DOUBLE PRECISION NOT NULL CHECK (amount > 0),
      payment_method TEXT NOT NULL DEFAULT '',
      payment_reference TEXT NOT NULL,
      payment_proof TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'unboosted')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
      UNIQUE (post_id, user_id)
    );

-- Table: brokerage_contracts
CREATE TABLE IF NOT EXISTS brokerage_contracts (
      _id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      contract_number TEXT UNIQUE,
      client_id BIGINT,
      service_type_id BIGINT,
      contract_type TEXT,
      start_date TEXT,
      end_date TEXT,
      commission_amount DOUBLE PRECISION,
      commission_percentage DOUBLE PRECISION,
      status TEXT DEFAULT 'active',
      notes TEXT,
      created_by BIGINT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP::text,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: clients
CREATE TABLE IF NOT EXISTS clients (
      _id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      client_type TEXT,
      full_name TEXT,
      company_name TEXT,
      national_id TEXT,
      tax_number TEXT,
      email TEXT,
      phone TEXT,
      secondary_phone TEXT,
      address TEXT,
      city TEXT,
      country TEXT,
      notes TEXT,
      status TEXT DEFAULT 'active',
      created_by BIGINT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP::text,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: contact_inquiries
CREATE TABLE IF NOT EXISTS contact_inquiries (
      _id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      inquiry_type TEXT,
      full_name TEXT,
      email TEXT,
      phone TEXT,
      subject TEXT,
      message TEXT,
      status TEXT DEFAULT 'new',
      priority TEXT DEFAULT 'medium',
      assigned_to BIGINT,
      response TEXT,
      responded_at TEXT,
      ip_address TEXT,
      user_agent TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP::text,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: daily_game_reward_plays
CREATE TABLE IF NOT EXISTS daily_game_reward_plays (
      play_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      game_id TEXT NOT NULL,
      segment_id TEXT NOT NULL,
      segment_label TEXT NOT NULL,
      coins_awarded BIGINT NOT NULL CHECK (coins_awarded >= 0),
      played_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: daily_game_reward_settings
CREATE TABLE IF NOT EXISTS daily_game_reward_settings (
      setting_id BIGINT PRIMARY KEY CHECK (setting_id = 1),
      games_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: data_registrations
CREATE TABLE IF NOT EXISTS data_registrations (
      _id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      work_type TEXT,
      staff_id BIGINT,
      staff_username TEXT,
      staff_full_name TEXT,
      client_name TEXT,
      city TEXT DEFAULT 'Harar',
      kebele TEXT,
      house_no TEXT,
      receipt_no TEXT,
      transaction_number TEXT,
      client_phone TEXT,
      tv_no TEXT,
      person TEXT,
      client_email TEXT,
      client_type TEXT,
      project_title TEXT,
      org_type TEXT,
      contact_person TEXT,
      address TEXT,
      condition TEXT,
      sign TEXT,
      gov_letter TEXT,
      paid_amount DOUBLE PRECISION,
      payment_status TEXT DEFAULT 'unpaid',
      round BIGINT NOT NULL DEFAULT 1,
      payment_period_type TEXT DEFAULT '2014-2018',
      payment_period_from TEXT,
      payment_period_to TEXT,
      commission_period_amount DOUBLE PRECISION,
      commission_fee DOUBLE PRECISION,
      commission_total DOUBLE PRECISION,
      collected_amount DOUBLE PRECISION,
      registration_datetime TEXT,
      registered_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP::text,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP::text
    , bank_receipt_pdf TEXT DEFAULT NULL);

-- Table: fixed_transactions
CREATE TABLE IF NOT EXISTS fixed_transactions (
      _id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      transaction_number TEXT UNIQUE,
      contract_id BIGINT,
      client_id BIGINT,
      service_type_id BIGINT,
      property_type TEXT,
      property_address TEXT,
      property_area DOUBLE PRECISION,
      area_unit TEXT,
      sale_price DOUBLE PRECISION,
      commission_amount DOUBLE PRECISION,
      commission_percentage DOUBLE PRECISION,
      currency TEXT DEFAULT 'ETB',
      transaction_date TEXT,
      payment_received DOUBLE PRECISION DEFAULT 0,
      payment_status TEXT DEFAULT 'pending',
      status TEXT DEFAULT 'pending',
      notes TEXT,
      assigned_to BIGINT,
      created_by BIGINT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP::text,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: link_campaign_settings
CREATE TABLE IF NOT EXISTS link_campaign_settings (
      setting_id BIGINT PRIMARY KEY CHECK (setting_id = 1),
      price_1_3 DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (price_1_3 >= 0),
      price_4_7 DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (price_4_7 >= 0),
      price_8_15 DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (price_8_15 >= 0),
      price_16_30 DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (price_16_30 >= 0),
      price_31_60 DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (price_31_60 >= 0),
      price_61_180 DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (price_61_180 >= 0),
      price_181_365 DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (price_181_365 >= 0),
      viewer_coins BIGINT NOT NULL DEFAULT 0 CHECK (viewer_coins >= 0),
      poster_coins BIGINT NOT NULL DEFAULT 0 CHECK (poster_coins >= 0),
      view_seconds BIGINT NOT NULL DEFAULT 30 CHECK (view_seconds BETWEEN 1 AND 3600),
      close_delay_seconds BIGINT NOT NULL DEFAULT 8 CHECK (close_delay_seconds BETWEEN 0 AND 300),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: link_campaign_views
CREATE TABLE IF NOT EXISTS link_campaign_views (
      view_id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      viewer_user_id TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
      last_progress_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
      active_seconds BIGINT NOT NULL DEFAULT 0 CHECK (active_seconds >= 0),
      claimed_at TEXT,
      viewer_coins BIGINT NOT NULL DEFAULT 0 CHECK (viewer_coins >= 0),
      poster_coins BIGINT NOT NULL DEFAULT 0 CHECK (poster_coins >= 0),
      UNIQUE (campaign_id, viewer_user_id)
    );

-- Table: link_campaigns
CREATE TABLE IF NOT EXISTS link_campaigns (
      campaign_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      app_name TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      images_json TEXT NOT NULL DEFAULT '[]',
      duration_tier TEXT NOT NULL CHECK (duration_tier IN ('1-3', '4-7', '8-15', '16-30', '31-60', '61-180', '181-365')),
      duration_days BIGINT NOT NULL CHECK (duration_days BETWEEN 1 AND 365),
      payment_amount DOUBLE PRECISION NOT NULL CHECK (payment_amount > 0),
      payment_method TEXT NOT NULL,
      payment_reference TEXT NOT NULL,
      payment_proof TEXT,
      viewer_coins BIGINT NOT NULL DEFAULT 0 CHECK (viewer_coins >= 0),
      poster_coins BIGINT NOT NULL DEFAULT 0 CHECK (poster_coins >= 0),
      view_seconds BIGINT NOT NULL DEFAULT 30 CHECK (view_seconds BETWEEN 1 AND 3600),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
      starts_at TEXT,
      expires_at TEXT,
      reviewed_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: live_chat_conversations
CREATE TABLE IF NOT EXISTS live_chat_conversations (
      conversation_id TEXT PRIMARY KEY,
      participant_type TEXT NOT NULL CHECK(participant_type IN ('guest', 'account')),
      participant_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      account_id TEXT,
      account_role TEXT,
      display_name TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP::text,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: live_chat_messages
CREATE TABLE IF NOT EXISTS live_chat_messages (
      _id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      sender TEXT NOT NULL CHECK(sender IN ('client', 'admin')),
      sender_name TEXT,
      type TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      attachment_name TEXT,
      attachment_mime TEXT,
      attachment_data TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP::text
    , sender_identity TEXT, edited_at TEXT, deleted_at TEXT, reply_to_message_id BIGINT, forwarded_from_message_id BIGINT);

-- Table: marketplace_settings
CREATE TABLE IF NOT EXISTS marketplace_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL
    );

-- Table: mini_ride_driver_applications
CREATE TABLE IF NOT EXISTS mini_ride_driver_applications (
      application_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      full_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT,
      address TEXT NOT NULL,
      city TEXT NOT NULL,
      national_id_number TEXT NOT NULL,
      national_id_front TEXT NOT NULL,
      national_id_back TEXT NOT NULL,
      driver_license TEXT NOT NULL,
      collateral TEXT NOT NULL,
      agreement_accepted BIGINT NOT NULL DEFAULT 0 CHECK (agreement_accepted IN (0, 1)),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      review_note TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: mini_ride_drivers
CREATE TABLE IF NOT EXISTS mini_ride_drivers (
      user_id TEXT PRIMARY KEY,
      is_online BIGINT NOT NULL DEFAULT 0 CHECK (is_online IN (0, 1)),
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      location_updated_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: mini_ride_location_points
CREATE TABLE IF NOT EXISTS mini_ride_location_points (
      point_id TEXT PRIMARY KEY,
      ride_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('driver', 'passenger')),
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: mini_ride_settings
CREATE TABLE IF NOT EXISTS mini_ride_settings (
      id BIGINT PRIMARY KEY CHECK (id = 1),
      base_fare DOUBLE PRECISION NOT NULL DEFAULT 50 CHECK (base_fare >= 0),
      fare_per_km DOUBLE PRECISION NOT NULL DEFAULT 20 CHECK (fare_per_km >= 0),
      fare_per_ton DOUBLE PRECISION NOT NULL DEFAULT 500 CHECK (fare_per_ton >= 0),
      driver_commission_percent DOUBLE PRECISION NOT NULL DEFAULT 80 CHECK (driver_commission_percent BETWEEN 0 AND 100),
      passenger_coin_reward BIGINT NOT NULL DEFAULT 20 CHECK (passenger_coin_reward >= 0),
      driver_coin_reward BIGINT NOT NULL DEFAULT 20 CHECK (driver_coin_reward >= 0),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: mini_rides
CREATE TABLE IF NOT EXISTS mini_rides (
      ride_id TEXT PRIMARY KEY,
      passenger_user_id TEXT NOT NULL,
      driver_user_id TEXT,
      passenger_name TEXT NOT NULL,
      passenger_phone TEXT NOT NULL,
      pickup_label TEXT NOT NULL,
      pickup_latitude DOUBLE PRECISION NOT NULL,
      pickup_longitude DOUBLE PRECISION NOT NULL,
      destination TEXT NOT NULL,
      load_kg DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (load_kg >= 0),
      status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'accepted', 'in_progress', 'awaiting_payment', 'payment_review', 'cash_confirmation', 'completed', 'cancelled')),
      payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'pending', 'paid', 'rejected')),
      payment_method TEXT,
      payment_reference TEXT,
      distance_km DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (distance_km >= 0),
      fare_amount DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (fare_amount >= 0),
      driver_latitude DOUBLE PRECISION,
      driver_longitude DOUBLE PRECISION,
      passenger_latitude DOUBLE PRECISION,
      passenger_longitude DOUBLE PRECISION,
      started_at TEXT,
      completed_at TEXT,
      paid_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
    , destination_latitude DOUBLE PRECISION, destination_longitude DOUBLE PRECISION, route_distance_km DOUBLE PRECISION NOT NULL DEFAULT 0, ride_paused_at TEXT);

-- Table: movable_transactions
CREATE TABLE IF NOT EXISTS movable_transactions (
      _id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      transaction_number TEXT UNIQUE,
      contract_id BIGINT,
      client_id BIGINT,
      service_type_id BIGINT,
      item_type TEXT,
      item_description TEXT,
      item_specifications TEXT,
      quantity BIGINT,
      unit_price DOUBLE PRECISION,
      total_value DOUBLE PRECISION,
      commission_amount DOUBLE PRECISION,
      commission_percentage DOUBLE PRECISION,
      currency TEXT DEFAULT 'ETB',
      transaction_date TEXT,
      payment_received DOUBLE PRECISION DEFAULT 0,
      payment_status TEXT DEFAULT 'pending',
      status TEXT DEFAULT 'pending',
      notes TEXT,
      assigned_to BIGINT,
      created_by BIGINT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP::text,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: owner_receipt_documents
CREATE TABLE IF NOT EXISTS owner_receipt_documents (
      registration_id BIGINT PRIMARY KEY,
      pdf_data TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP::text,
      FOREIGN KEY (registration_id) REFERENCES data_registrations(_id) ON DELETE CASCADE
    );

-- Table: platform_payout_ledger
CREATE TABLE IF NOT EXISTS platform_payout_ledger (
      payout_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      agent_user_id TEXT,
      amount DOUBLE PRECISION NOT NULL CHECK (amount < 0),
      request_id TEXT NOT NULL,
      entry_type TEXT NOT NULL,
      reference TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: platform_service_charge_ledger
CREATE TABLE IF NOT EXISTS platform_service_charge_ledger (
      entry_id TEXT PRIMARY KEY,
      amount DOUBLE PRECISION NOT NULL,
      request_id TEXT NOT NULL,
      entry_type TEXT NOT NULL CHECK (entry_type IN ('service_charge', 'agent_reward')),
      reference TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: project_documents
CREATE TABLE IF NOT EXISTS project_documents (
      project_title TEXT PRIMARY KEY,
      pdf_data TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: promo_code_claims
CREATE TABLE IF NOT EXISTS promo_code_claims (
          claim_id TEXT PRIMARY KEY,
          code_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          code TEXT NOT NULL,
          amount DOUBLE PRECISION NOT NULL CHECK (amount >= 0),
          reward_type TEXT NOT NULL DEFAULT 'bonus' CHECK (reward_type IN ('bonus', 'real', 'coin')),
          claimed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
          UNIQUE (code_id, user_id)
        );

-- Table: promo_codes
CREATE TABLE IF NOT EXISTS promo_codes (
          code_id TEXT PRIMARY KEY,
          code TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL DEFAULT 'Promo reward',
          description TEXT NOT NULL DEFAULT '',
          amount DOUBLE PRECISION NOT NULL CHECK (amount > 0),
          reward_type TEXT NOT NULL DEFAULT 'bonus' CHECK (reward_type IN ('bonus', 'real', 'coin')),
          expires_at TEXT,
          max_claims BIGINT NOT NULL DEFAULT 1 CHECK (max_claims >= 0),
          broadcast_to_all BIGINT NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'expired')),
          created_by TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
        );

-- Table: promotions
CREATE TABLE IF NOT EXISTS promotions (
      promotion_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      image_data TEXT,
      audio_data TEXT,
      button_text TEXT,
      button_url TEXT,
      background_color TEXT NOT NULL DEFAULT '#8b0000',
      audience_status TEXT NOT NULL DEFAULT 'all' CHECK (audience_status IN ('all', 'paid', 'unpaid', 'guest', 'user', 'other')),
      badge_text TEXT,
      alert_enabled BIGINT NOT NULL DEFAULT 1,
      pinned BIGINT NOT NULL DEFAULT 0,
      popup_enabled BIGINT NOT NULL DEFAULT 0,
      is_hidden BIGINT NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: registration_image_documents
CREATE TABLE IF NOT EXISTS registration_image_documents (
      registration_id BIGINT PRIMARY KEY,
      image_data TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP::text,
      FOREIGN KEY (registration_id) REFERENCES data_registrations(_id) ON DELETE CASCADE
    );

-- Table: service_booking_requests
CREATE TABLE IF NOT EXISTS service_booking_requests (
      _id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      requestId TEXT UNIQUE NOT NULL,
      request_id TEXT UNIQUE NOT NULL,
      customerUserId TEXT,
      customer_user_id TEXT,
      itemId TEXT,
      item_id TEXT,
      itemName TEXT,
      item_name TEXT,
      category TEXT,
      amount TEXT,
      paymentType TEXT,
      payment_type TEXT,
      paymentLabel TEXT,
      payment_label TEXT,
      paymentMethod TEXT,
      payment_method TEXT,
      customerName TEXT,
      customer_name TEXT,
      customerPhone TEXT,
      customer_phone TEXT,
      transactionReference TEXT,
      transaction_reference TEXT,
      paymentAccount TEXT,
      paymentStatus TEXT DEFAULT 'submitted',
      payment_status TEXT DEFAULT 'submitted',
      status TEXT DEFAULT 'pending_approval',
      requestedAt TEXT,
      requested_at TEXT,
      approvedAt TEXT,
      approved_at TEXT,
      cancelledAt TEXT,
      cancelled_at TEXT,
      updatedAt TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP::text
    , deliveryRequested BIGINT DEFAULT 0, deliveryFee TEXT DEFAULT '0', deliveryStatus TEXT DEFAULT 'not_requested');

-- Table: service_catalog_products
CREATE TABLE IF NOT EXISTS service_catalog_products (
      product_id TEXT PRIMARY KEY,
      service_key TEXT NOT NULL CHECK (service_key IN ('broker-house', 'create-partnership', 'room-booking', 'logistics', 'movable-services')),
      product_json TEXT NOT NULL,
      published BIGINT NOT NULL DEFAULT 0,
      boosted BIGINT NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
    , owner_user_id TEXT, approval_status TEXT NOT NULL DEFAULT 'approved');

-- Table: service_payment_settings
CREATE TABLE IF NOT EXISTS service_payment_settings (
      _id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      configKey TEXT UNIQUE NOT NULL,
      configJson TEXT NOT NULL,
      updatedAt TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: service_types
CREATE TABLE IF NOT EXISTS service_types (
      _id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      category TEXT,
      service_name TEXT,
      service_name_ar TEXT,
      description TEXT,
      is_active BIGINT DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP::text,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: social_follows
CREATE TABLE IF NOT EXISTS social_follows (
      follower_id TEXT NOT NULL,
      followed_id TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP::text,
      PRIMARY KEY (follower_id, followed_id),
      CHECK (follower_id <> followed_id)
    );

-- Table: social_friend_requests
CREATE TABLE IF NOT EXISTS social_friend_requests (
      request_id TEXT PRIMARY KEY,
      requester_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP::text,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP::text,
      UNIQUE (requester_id, recipient_id),
      CHECK (requester_id <> recipient_id)
    );

-- Table: social_messages
CREATE TABLE IF NOT EXISTS social_messages (
      message_id TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP::text,
      read_at TEXT
    , type TEXT NOT NULL DEFAULT 'text', edited_at TEXT, deleted_at TEXT, reply_to_message_id TEXT, forwarded_from_message_id TEXT, caption TEXT);

-- Table: social_moderation_log
CREATE TABLE IF NOT EXISTS social_moderation_log (
      moderation_id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      target_user_id TEXT NOT NULL,
      moderator_user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: social_notifications
CREATE TABLE IF NOT EXISTS social_notifications (
      notification_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      actor_id TEXT,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      link TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP::text,
      read_at TEXT
    );

-- Table: social_post_comments
CREATE TABLE IF NOT EXISTS social_post_comments (
      comment_id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: social_post_likes
CREATE TABLE IF NOT EXISTS social_post_likes (
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP::text,
      PRIMARY KEY (post_id, user_id)
    );

-- Table: social_post_reports
CREATE TABLE IF NOT EXISTS social_post_reports (
      report_id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      reporter_user_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      details TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
      reviewed_by TEXT,
      review_reason TEXT,
      reviewed_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP::text,
      UNIQUE (post_id, reporter_user_id)
    );

-- Table: social_post_shares
CREATE TABLE IF NOT EXISTS social_post_shares (
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP::text,
      PRIMARY KEY (post_id, user_id)
    );

-- Table: social_posts
CREATE TABLE IF NOT EXISTS social_posts (
      post_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      product_name TEXT,
      product_price DOUBLE PRECISION,
      product_url TEXT,
      repost_of TEXT,
      visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'friends', 'private')),
      moderation_status TEXT NOT NULL DEFAULT 'active' CHECK (moderation_status IN ('active', 'hidden')),
      moderation_reason TEXT,
      moderated_by TEXT,
      moderated_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP::text
    , product_image TEXT, location TEXT DEFAULT '', mentions TEXT DEFAULT '[]', hashtags TEXT DEFAULT '[]', tagged_friends TEXT DEFAULT '[]');

-- Table: social_presence
CREATE TABLE IF NOT EXISTS social_presence (
      user_id TEXT PRIMARY KEY,
      last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: social_referral_joins
CREATE TABLE IF NOT EXISTS social_referral_joins (
      new_user_id TEXT PRIMARY KEY,
      inviter_user_id TEXT NOT NULL,
      referral_code TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: social_referrals
CREATE TABLE IF NOT EXISTS social_referrals (
      referral_code TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: social_stories
CREATE TABLE IF NOT EXISTS social_stories (
      story_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      image_data TEXT,
      cover_color TEXT NOT NULL DEFAULT '#8b0000',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP::text,
      expires_at TEXT NOT NULL
    );

-- Table: social_story_comments
CREATE TABLE IF NOT EXISTS social_story_comments (
      comment_id TEXT PRIMARY KEY,
      story_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: social_story_likes
CREATE TABLE IF NOT EXISTS social_story_likes (
      story_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP::text,
      PRIMARY KEY (story_id, user_id)
    );

-- Table: social_story_moderation_log
CREATE TABLE IF NOT EXISTS social_story_moderation_log (
      moderation_id TEXT PRIMARY KEY,
      story_id TEXT NOT NULL,
      target_user_id TEXT NOT NULL,
      moderator_user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: social_story_shares
CREATE TABLE IF NOT EXISTS social_story_shares (
      story_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP::text,
      PRIMARY KEY (story_id, user_id)
    );

-- Table: users
CREATE TABLE IF NOT EXISTS users (
      _id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      full_name TEXT,
      role TEXT DEFAULT 'user',
      position TEXT,
      phone TEXT,
      permissions TEXT,
      commission_settings TEXT,
      is_active BIGINT DEFAULT 1,
      social_restricted BIGINT NOT NULL DEFAULT 0,
      social_restriction_reason TEXT,
      social_banned BIGINT NOT NULL DEFAULT 0,
      social_ban_reason TEXT,
      social_ban_previous_active BIGINT NOT NULL DEFAULT 1,
      last_login TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP::text,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP::text
    , created_by_user_id TEXT, created_by_role TEXT, telegram_chat_id TEXT);

-- Table: utility_payment_requests
CREATE TABLE IF NOT EXISTS utility_payment_requests (
    request_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'request'
      CHECK (status IN ('request', 'approved', 'receipt', 'cancelled')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
  );

-- Table: wallet_coin_ledger
CREATE TABLE IF NOT EXISTS wallet_coin_ledger (
      entry_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      amount BIGINT NOT NULL,
      entry_type TEXT NOT NULL,
      reference TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: wallet_coin_level_history
CREATE TABLE IF NOT EXISTS wallet_coin_level_history (
      achievement_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      level BIGINT NOT NULL CHECK (level BETWEEN 1 AND 8),
      earned_coins BIGINT NOT NULL CHECK (earned_coins >= 0),
      reward_etb DOUBLE PRECISION NOT NULL CHECK (reward_etb >= 0),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
      UNIQUE (user_id, level)
    );

-- Table: wallet_coin_level_rules
CREATE TABLE IF NOT EXISTS wallet_coin_level_rules (
      level BIGINT PRIMARY KEY CHECK (level BETWEEN 1 AND 8),
      required_coins BIGINT NOT NULL CHECK (required_coins >= 0),
      reward_etb DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (reward_etb >= 0),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: wallet_coin_savings
CREATE TABLE IF NOT EXISTS wallet_coin_savings (
      deposit_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      principal BIGINT NOT NULL CHECK (principal > 0),
      daily_rate_percent DOUBLE PRECISION NOT NULL CHECK (daily_rate_percent >= 0),
      duration_days BIGINT NOT NULL CHECK (duration_days > 0),
      expected_interest BIGINT NOT NULL CHECK (expected_interest >= 0),
      maturity_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'matured')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
      settled_at TEXT
    );

-- Table: wallet_deposits
CREATE TABLE IF NOT EXISTS wallet_deposits (
      deposit_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      amount DOUBLE PRECISION NOT NULL CHECK (amount > 0),
      payment_method TEXT NOT NULL,
      payment_reference TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      created_at TEXT DEFAULT CURRENT_TIMESTAMP::text,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP::text
    );

-- Table: wallet_ledger
CREATE TABLE IF NOT EXISTS wallet_ledger (
      entry_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      amount DOUBLE PRECISION NOT NULL,
      entry_type TEXT NOT NULL,
      reference TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'ETB',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP::text
    , balance_type TEXT NOT NULL DEFAULT 'bonus');

-- Table: wallet_settings
CREATE TABLE IF NOT EXISTS wallet_settings (
      role TEXT PRIMARY KEY,
      signup_bonus DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (signup_bonus >= 0),
      invite_reward DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (invite_reward >= 0),
      share_reward DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (share_reward >= 0),
      product_sale_percent DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (product_sale_percent >= 0 AND product_sale_percent <= 100),
      currency TEXT NOT NULL DEFAULT 'ETB'
    , invite_reward_trigger TEXT NOT NULL DEFAULT 'first_approved_purchase', coin_login_reward BIGINT NOT NULL DEFAULT 0, coin_share_reward BIGINT NOT NULL DEFAULT 0, coin_invite_reward BIGINT NOT NULL DEFAULT 0, coin_purchase_reward BIGINT NOT NULL DEFAULT 0, coin_gift_receive_reward BIGINT NOT NULL DEFAULT 0, coin_gift_bonus_percent DOUBLE PRECISION NOT NULL DEFAULT 0, coin_per_etb BIGINT NOT NULL DEFAULT 100, min_coin_conversion BIGINT NOT NULL DEFAULT 100, max_coin_conversion BIGINT NOT NULL DEFAULT 1000000, min_deposit DOUBLE PRECISION NOT NULL DEFAULT 0.01, max_deposit DOUBLE PRECISION NOT NULL DEFAULT 100000, min_withdrawal DOUBLE PRECISION NOT NULL DEFAULT 0.01, max_withdrawal DOUBLE PRECISION NOT NULL DEFAULT 100000, min_bonus_withdrawal DOUBLE PRECISION NOT NULL DEFAULT 0.01, max_bonus_withdrawal DOUBLE PRECISION NOT NULL DEFAULT 100000, bonus_to_real_rate DOUBLE PRECISION NOT NULL DEFAULT 0, coin_savings_daily_rate DOUBLE PRECISION NOT NULL DEFAULT 0, min_coin_savings_deposit BIGINT NOT NULL DEFAULT 1, max_coin_savings_deposit BIGINT NOT NULL DEFAULT 1000000);

-- Table: wallet_withdrawals
CREATE TABLE IF NOT EXISTS wallet_withdrawals (
      withdrawal_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      amount DOUBLE PRECISION NOT NULL CHECK (amount > 0),
      payout_details TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP::text,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP::text
    , balance_type TEXT NOT NULL DEFAULT 'real' CHECK (balance_type IN ('real', 'bonus')), transaction_reference TEXT NOT NULL DEFAULT '', receipt_file TEXT);

-- Table: bank_receipt_documents
CREATE TABLE IF NOT EXISTS bank_receipt_documents (
      registration_id BIGINT PRIMARY KEY,
      pdf_data TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP::text,
      FOREIGN KEY (registration_id) REFERENCES data_registrations(_id) ON DELETE CASCADE
    );

-- Runtime-created tables and indexes used by authentication, Telegram, and website content.
CREATE TABLE IF NOT EXISTS otp_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    encrypted_config TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
  );

CREATE TABLE IF NOT EXISTS telegram_link_challenges (
    challenge_id TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    chat_id TEXT NOT NULL,
    request_ip TEXT NOT NULL DEFAULT '',
    code_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
    consumed_at TEXT
  );

CREATE TABLE IF NOT EXISTS telegram_registration_contacts (
    telegram_user_id TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
  );

CREATE TABLE IF NOT EXISTS otp_challenges (
    challenge_id TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    request_ip TEXT NOT NULL DEFAULT '',
    purpose TEXT NOT NULL,
    channel TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    data_json TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
    consumed_at TEXT
  );

CREATE TABLE IF NOT EXISTS registration_otp_tickets (
    challenge_id TEXT PRIMARY KEY,
    contact_type TEXT NOT NULL,
    contact TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
    used_at TEXT
  );

CREATE TABLE IF NOT EXISTS guest_upgrade_requests (
    request_id TEXT PRIMARY KEY,
    access_hash TEXT NOT NULL,
    request_type TEXT NOT NULL DEFAULT 'upgrade',
    username TEXT,
    full_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT,
    password_hash TEXT NOT NULL,
    referral_code TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    otp_hash TEXT,
    otp_encrypted TEXT,
    otp_expires_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
    approved_at TEXT,
    completed_at TEXT,
    request_ip TEXT NOT NULL DEFAULT ''
  );

CREATE TABLE IF NOT EXISTS site_content_settings (
    id BIGINT PRIMARY KEY CHECK (id = 1),
    content_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
  );

CREATE INDEX IF NOT EXISTS idx_telegram_link_user_created
    ON telegram_link_challenges(user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_otp_challenges_phone_created
    ON otp_challenges(phone, created_at);

CREATE INDEX IF NOT EXISTS idx_otp_challenges_ip_created
    ON otp_challenges(request_ip, created_at);

CREATE INDEX IF NOT EXISTS idx_guest_upgrade_status_created
    ON guest_upgrade_requests(status, created_at);

-- Index: idx_agent_commission_records_owner
CREATE INDEX IF NOT EXISTS idx_agent_commission_records_owner ON agent_commission_records(agent_user_id, created_at DESC);

-- Index: idx_agent_package_requests_status
CREATE INDEX IF NOT EXISTS idx_agent_package_requests_status ON agent_package_requests(status, created_at DESC);

-- Index: idx_agent_product_history_owner
CREATE INDEX IF NOT EXISTS idx_agent_product_history_owner ON agent_product_history(agent_user_id, created_at DESC);

-- Index: idx_agent_products_owner
CREATE INDEX IF NOT EXISTS idx_agent_products_owner ON agent_products(agent_user_id, updated_at DESC);

-- Index: idx_agent_wallet_requests_agent
CREATE INDEX IF NOT EXISTS idx_agent_wallet_requests_agent ON agent_wallet_requests(agent_user_id, status, created_at DESC);

-- Index: idx_agent_wallet_requests_user
CREATE INDEX IF NOT EXISTS idx_agent_wallet_requests_user ON agent_wallet_requests(user_id, created_at DESC);

-- Index: idx_boost_requests_status
CREATE INDEX IF NOT EXISTS idx_boost_requests_status ON boost_requests(status, created_at DESC);

-- Index: idx_catalog_products_service
CREATE INDEX IF NOT EXISTS idx_catalog_products_service ON service_catalog_products(service_key, published, boosted);

-- Index: idx_clients_phone
CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients(phone);

-- Index: idx_clients_status
CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status);

-- Index: idx_daily_game_reward_plays_user_game_time
CREATE INDEX IF NOT EXISTS idx_daily_game_reward_plays_user_game_time
      ON daily_game_reward_plays(user_id, game_id, played_at DESC);

-- Index: idx_data_registrations_payment_status
CREATE INDEX IF NOT EXISTS idx_data_registrations_payment_status ON data_registrations(payment_status);

-- Index: idx_data_registrations_staff_id
CREATE INDEX IF NOT EXISTS idx_data_registrations_staff_id ON data_registrations(staff_id);

-- Index: idx_fixed_transactions_client_id
CREATE INDEX IF NOT EXISTS idx_fixed_transactions_client_id ON fixed_transactions(client_id);

-- Index: idx_link_campaign_views_user
CREATE INDEX IF NOT EXISTS idx_link_campaign_views_user ON link_campaign_views(viewer_user_id, claimed_at);

-- Index: idx_link_campaigns_status_expiry
CREATE INDEX IF NOT EXISTS idx_link_campaigns_status_expiry ON link_campaigns(status, expires_at);

-- Index: idx_link_campaigns_user
CREATE INDEX IF NOT EXISTS idx_link_campaigns_user ON link_campaigns(user_id, created_at DESC);

-- Index: idx_live_chat_conversation
CREATE INDEX IF NOT EXISTS idx_live_chat_conversation
      ON live_chat_messages(conversation_id, _id);

-- Index: idx_live_chat_created
CREATE INDEX IF NOT EXISTS idx_live_chat_created
      ON live_chat_messages(created_at);

-- Index: idx_live_chat_participant
CREATE INDEX IF NOT EXISTS idx_live_chat_participant
      ON live_chat_conversations(participant_type, participant_id, device_id);

-- Index: idx_mini_ride_drivers_online
CREATE INDEX IF NOT EXISTS idx_mini_ride_drivers_online ON mini_ride_drivers(is_online, location_updated_at);

-- Index: idx_mini_ride_points_ride
CREATE INDEX IF NOT EXISTS idx_mini_ride_points_ride ON mini_ride_location_points(ride_id, recorded_at);

-- Index: idx_mini_rides_driver
CREATE INDEX IF NOT EXISTS idx_mini_rides_driver ON mini_rides(driver_user_id, created_at DESC);

-- Index: idx_mini_rides_passenger
CREATE INDEX IF NOT EXISTS idx_mini_rides_passenger ON mini_rides(passenger_user_id, created_at DESC);

-- Index: idx_mini_rides_status
CREATE INDEX IF NOT EXISTS idx_mini_rides_status ON mini_rides(status, created_at DESC);

-- Index: idx_movable_transactions_client_id
CREATE INDEX IF NOT EXISTS idx_movable_transactions_client_id ON movable_transactions(client_id);

-- Index: idx_platform_payout_agent
CREATE INDEX IF NOT EXISTS idx_platform_payout_agent ON platform_payout_ledger(agent_user_id, created_at DESC);

-- Index: idx_platform_payout_date
CREATE INDEX IF NOT EXISTS idx_platform_payout_date ON platform_payout_ledger(created_at DESC);

-- Index: idx_platform_payout_user
CREATE INDEX IF NOT EXISTS idx_platform_payout_user ON platform_payout_ledger(user_id, created_at DESC);

-- Index: idx_platform_service_charge_date
CREATE INDEX IF NOT EXISTS idx_platform_service_charge_date ON platform_service_charge_ledger(created_at DESC);

-- Index: idx_promo_code_claims_user
CREATE INDEX IF NOT EXISTS idx_promo_code_claims_user ON promo_code_claims(user_id, claimed_at DESC);

-- Index: idx_promo_codes_active
CREATE INDEX IF NOT EXISTS idx_promo_codes_active ON promo_codes(status, expires_at, created_at DESC);

-- Index: idx_promotions_visible
CREATE INDEX IF NOT EXISTS idx_promotions_visible ON promotions(is_hidden, pinned, created_at DESC);

-- Index: idx_service_booking_request_id
CREATE UNIQUE INDEX IF NOT EXISTS idx_service_booking_request_id ON service_booking_requests(requestId);

-- Index: idx_social_messages_pair
CREATE INDEX IF NOT EXISTS idx_social_messages_pair ON social_messages(sender_id, recipient_id, created_at DESC);

-- Index: idx_social_messages_unread
CREATE INDEX IF NOT EXISTS idx_social_messages_unread ON social_messages(recipient_id, read_at);

-- Index: idx_social_moderation_log_post
CREATE INDEX IF NOT EXISTS idx_social_moderation_log_post ON social_moderation_log(post_id, created_at DESC);

-- Index: idx_social_notifications_unread
CREATE INDEX IF NOT EXISTS idx_social_notifications_unread ON social_notifications(user_id, read_at);

-- Index: idx_social_notifications_user
CREATE INDEX IF NOT EXISTS idx_social_notifications_user ON social_notifications(user_id, created_at DESC);

-- Index: idx_social_post_comments_post
CREATE INDEX IF NOT EXISTS idx_social_post_comments_post ON social_post_comments(post_id, created_at);

-- Index: idx_social_post_reports_post_status
CREATE INDEX IF NOT EXISTS idx_social_post_reports_post_status ON social_post_reports(post_id, status);

-- Index: idx_social_post_reports_status
CREATE INDEX IF NOT EXISTS idx_social_post_reports_status ON social_post_reports(status, created_at DESC);

-- Index: idx_social_posts_created
CREATE INDEX IF NOT EXISTS idx_social_posts_created ON social_posts(created_at DESC);

-- Index: idx_social_stories_expiry
CREATE INDEX IF NOT EXISTS idx_social_stories_expiry ON social_stories(expires_at DESC);

-- Index: idx_social_story_comments_story
CREATE INDEX IF NOT EXISTS idx_social_story_comments_story ON social_story_comments(story_id, created_at);

-- Index: idx_users_email
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Index: idx_users_role
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- Index: idx_users_username
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- Index: idx_utility_payment_status_created
CREATE INDEX IF NOT EXISTS idx_utility_payment_status_created
    ON utility_payment_requests(status, created_at DESC);

-- Index: idx_utility_payment_user_created
CREATE INDEX IF NOT EXISTS idx_utility_payment_user_created
    ON utility_payment_requests(user_id, created_at DESC);

-- Index: idx_wallet_coin_ledger_user
CREATE INDEX IF NOT EXISTS idx_wallet_coin_ledger_user ON wallet_coin_ledger(user_id, created_at DESC);

-- Index: idx_wallet_coin_savings_maturity
CREATE INDEX IF NOT EXISTS idx_wallet_coin_savings_maturity ON wallet_coin_savings(status, maturity_at);

-- Index: idx_wallet_coin_savings_user
CREATE INDEX IF NOT EXISTS idx_wallet_coin_savings_user ON wallet_coin_savings(user_id, created_at DESC);

-- Index: idx_wallet_deposits_status
CREATE INDEX IF NOT EXISTS idx_wallet_deposits_status ON wallet_deposits(status, created_at DESC);

-- Index: idx_wallet_ledger_user
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_user ON wallet_ledger(user_id, created_at DESC);

-- Index: idx_wallet_withdrawals_status
CREATE INDEX IF NOT EXISTS idx_wallet_withdrawals_status ON wallet_withdrawals(status, created_at DESC);


COMMIT;

SELECT COUNT(*) AS public_table_count FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';
