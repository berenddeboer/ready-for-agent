@ui-history
Feature: Lock document scrolling while a modal dialog is open
  Mouse-wheel and trackpad input must not move the page behind an open
  native modal. Dialog content and nested lists still scroll. Closing
  restores the originating offset. Coverage is representative rather than
  an exhaustive close-path cross-product (issue #1279).

  Scenario: Harness Settings locks an overflowing background and restores it
    Given the Harness has Session Telemetry fixtures
    And the Harness has a configured default build model
    When I open Completed page 2 directly
    And I cancel the Harness settings dialog if present
    And I prepare an overflowing page background at a nonzero scroll offset
    Then mouse-wheel input can move the page background
    When I open Harness settings from the masthead
    Then the Harness settings dialog is visible
    And the page background scroll position is unchanged
    And the page layout width is unchanged
    When I wheel over the dialog backdrop
    Then the page background scroll position is unchanged
    When I wheel over the open dialog
    Then the open dialog can scroll
    And the page background scroll position is unchanged
    When I wheel past the open dialog scroll boundary
    Then the page background scroll position is unchanged
    When I cancel the Harness settings dialog
    Then the Harness settings dialog is hidden
    And the page background scroll position is unchanged
    And mouse-wheel input can move the page background
    When I open Harness settings from the masthead
    And I go back in the browser
    Then the Harness settings dialog is hidden
    And the page background scroll position is unchanged
    When I go forward in the browser
    Then the Harness settings dialog is visible
    When I wheel over the dialog backdrop
    Then the page background scroll position is unchanged

  Scenario: Failed Save keeps the background locked
    Given the Harness has Session Telemetry fixtures
    And the Harness has a configured default build model
    When I open Completed page 2 directly
    And I cancel the Harness settings dialog if present
    And I prepare an overflowing page background at a nonzero scroll offset
    And I open Harness settings from the masthead
    And Harness settings Save is forced to fail
    And I save Harness settings expecting failure
    Then the Harness settings dialog is visible
    And a settings save error is shown
    When I wheel over the dialog backdrop
    Then the page background scroll position is unchanged

  Scenario: Pending Save keeps the background locked
    Given the Harness has Session Telemetry fixtures
    And the Harness has a configured default build model
    When I open Completed page 2 directly
    And I cancel the Harness settings dialog if present
    And I prepare an overflowing page background at a nonzero scroll offset
    And I open Harness settings from the masthead
    And Harness settings Save is delayed
    And I start saving Harness settings
    Then the Harness settings dialog is visible
    When I wheel over the dialog backdrop
    Then the page background scroll position is unchanged
    When I go back in the browser while Save is pending
    Then the Harness settings dialog is visible
    And the browser location is the settings path
    When I wheel over the dialog backdrop
    Then the page background scroll position is unchanged
    When the delayed Harness settings Save completes
    Then the Harness settings dialog is hidden
    And the page background scroll position is unchanged

  Scenario: First-run Settings locks the background without changing the URL
    Given the Harness is empty with first-run settings required
    When I open the home page
    Then the Harness settings dialog is visible
    And the browser location is the home path
    When I prepare an overflowing page background at a nonzero scroll offset
    And I wheel over the dialog backdrop
    Then the page background scroll position is unchanged
    When I wheel over the open dialog
    Then the page background scroll position is unchanged

  Scenario: Short Repository not found dialog does not scroll the background
    Given the Harness has a seeded Paused Repository
    And the Harness has a configured default build model
    When I open a stale repository settings path
    Then the Repository not found dialog is visible
    When I prepare an overflowing page background at a nonzero scroll offset
    And I wheel over the dialog backdrop
    Then the page background scroll position is unchanged
    When I wheel over the open dialog
    Then the page background scroll position is unchanged
    When I close the Repository not found dialog
    Then the Repository not found dialog is hidden
    And mouse-wheel input can move the page background

  Scenario: Repository settings participates in the shared lock
    Given the Harness has a seeded Paused Repository
    And the Harness has a configured default build model
    When I open the Repos page
    And I prepare an overflowing page background at a nonzero scroll offset
    And I open Repository settings from the card menu
    Then the Repository settings dialog is visible
    When I wheel over the dialog backdrop
    Then the page background scroll position is unchanged
    When I wheel over the open dialog
    Then the open dialog can scroll
    And the page background scroll position is unchanged

  Scenario: Session usage nested Agent Turn Tail remains scrollable
    Given the Harness has Session Telemetry fixtures
    And the Harness has a configured default build model
    When I open the home page
    And I cancel the Harness settings dialog if present
    And I prepare an overflowing page background at a nonzero scroll offset
    And I open Session usage with a long Agent Turn Tail from Pipeline
    Then the Session usage dialog is visible
    When I wheel over the dialog backdrop
    Then the page background scroll position is unchanged
    When I show the long Agent Turn Tail
    And I wheel over the Agent Turn Tail
    Then the Agent Turn Tail can scroll
    And the page background scroll position is unchanged
    When I wheel past the Agent Turn Tail scroll boundary
    Then the page background scroll position is unchanged

  Scenario: Implement With leaf keeps the lock from loading through the form
    Given the Harness has Implement With issue fixtures
    And the Harness has a configured default build model
    When I open the Repos page
    And Implement With preference loading is delayed
    And I open Implement With for the leaf Issue from Repos
    Then the Implement With dialog is visible
    And the Implement With dialog shows loading preferences
    When I prepare an overflowing page background at a nonzero scroll offset
    And I wheel over the dialog backdrop
    Then the page background scroll position is unchanged
    When the delayed Implement With preference loading completes
    Then the Implement With dialog shows the form
    When I wheel over the dialog backdrop
    Then the page background scroll position is unchanged
    When I wheel over the open dialog
    Then the page background scroll position is unchanged
    When I cancel the Implement With dialog
    Then the Implement With dialog is hidden
    And the page background scroll position is unchanged
    And mouse-wheel input can move the page background

  Scenario: Implement With parent participates in the shared lock
    Given the Harness has Implement With issue fixtures
    And the Harness has a configured default build model
    When I open the Repos page
    And I open Implement With for the parent Issue from Repos
    Then the Implement With dialog is visible
    And the Implement With dialog shows the form
    When I prepare an overflowing page background at a nonzero scroll offset
    And I wheel over the dialog backdrop
    Then the page background scroll position is unchanged
    When I cancel the Implement With dialog
    Then the Implement With dialog is hidden
    And the page background scroll position is unchanged

  Scenario: Narrow viewport still locks the background
    Given the Harness has Session Telemetry fixtures
    And the Harness has a configured default build model
    When I open Completed page 2 directly
    And I cancel the Harness settings dialog if present
    And I resize to a narrow short viewport
    And I prepare an overflowing page background at a nonzero scroll offset
    And I open Harness settings from the masthead
    Then the Harness settings dialog is visible
    When I wheel over the dialog backdrop
    Then the page background scroll position is unchanged
    When I wheel over the open dialog
    Then the open dialog can scroll
    And the page background scroll position is unchanged
