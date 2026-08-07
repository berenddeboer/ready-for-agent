Feature: Route Repository settings by Repository ID
  Explicit Repository settings opens use `/repos/<repository-id>/settings` so
  Back closes the dialog, Forward reopens it with saved values, and Save /
  Cancel / Escape stay synchronized with the browser location. Direct and
  stale links render over Repos. A configured default build model keeps
  first-run Harness Settings from competing with these scenarios.

  Background:
    Given the Harness has no configured Repositories
    And the Harness has a configured default build model

  Scenario: Explicit open pushes /repos/<id>/settings and preserves theme search
    Given the End-to-End Fixture Repository is checked out
    When I add the Repository with the CLI
    And I open the Repos page with theme dark
    And I open Repository settings from the card menu
    Then the browser location is the repository settings path with theme dark
    And the Repository settings dialog is visible
    And the Repos jobs tab is active

  Scenario: Browser Back closes Repository settings and Forward reopens with saved values
    Given the End-to-End Fixture Repository is checked out
    When I add the Repository with the CLI
    And I open the Repos page
    And I open Repository settings from the card menu
    Then the browser location is the repository settings path
    When I change the Repository paused draft
    And I go back in the browser
    Then the Repository settings dialog is hidden
    And the browser location is the repos path
    When I go forward in the browser
    Then the Repository settings dialog is visible
    And the browser location is the repository settings path
    And the Repository paused field shows the saved value not the draft

  Scenario: Cancel returns to the originating Repos location
    Given the End-to-End Fixture Repository is checked out
    When I add the Repository with the CLI
    And I open the Repos page
    And I open Repository settings from the card menu
    Then the browser location is the repository settings path
    When I cancel the Repository settings dialog
    Then the Repository settings dialog is hidden
    And the browser location is the repos path

  Scenario: Escape returns to the originating Repos location
    Given the End-to-End Fixture Repository is checked out
    When I add the Repository with the CLI
    And I open the Repos page
    And I open Repository settings from the card menu
    Then the browser location is the repository settings path
    When I press Escape in the Repository settings dialog
    Then the Repository settings dialog is hidden
    And the browser location is the repos path

  Scenario: Successful Save returns to the originating location
    Given the End-to-End Fixture Repository is checked out
    When I add the Repository with the CLI
    And I open the Repos page
    And I open Repository settings from the card menu
    Then the browser location is the repository settings path
    When I save Repository settings without changing values
    Then the Repository settings dialog is hidden
    And the browser location is the repos path

  Scenario: Failed Save keeps the dialog and settings path open
    Given the End-to-End Fixture Repository is checked out
    When I add the Repository with the CLI
    And I open the Repos page
    And I open Repository settings from the card menu
    Then the browser location is the repository settings path
    When Repository settings Save is forced to fail
    And I save Repository settings expecting failure
    Then the Repository settings dialog is visible
    And the browser location is the repository settings path
    And a repository settings save error is shown

  Scenario: Browser Back is blocked while Save is pending
    Given the End-to-End Fixture Repository is checked out
    When I add the Repository with the CLI
    And I open the Repos page
    And I open Repository settings from the card menu
    Then the browser location is the repository settings path
    When Repository settings Save is delayed
    And I start saving Repository settings
    And I go back in the browser while Repository settings Save is pending
    Then the Repository settings dialog is visible
    And the browser location is the repository settings path
    When the delayed Repository settings Save completes
    Then the Repository settings dialog is hidden
    And the browser location is the repos path

  Scenario: Direct repository settings navigation shows the dialog over Repos
    Given the End-to-End Fixture Repository is checked out
    When I add the Repository with the CLI
    And I open the repository settings path directly
    Then the Repository settings dialog is visible
    And the browser location is the repository settings path
    And the Repos jobs tab is active
    When I cancel the Repository settings dialog
    Then the Repository settings dialog is hidden
    And the browser location is the repos path

  Scenario: Refreshing repository settings keeps the dialog open and closes to Repos
    Given the End-to-End Fixture Repository is checked out
    When I add the Repository with the CLI
    And I open the repository settings path directly
    Then the Repository settings dialog is visible
    When I refresh the page
    Then the Repository settings dialog is visible
    And the browser location is the repository settings path
    When I cancel the Repository settings dialog
    Then the Repository settings dialog is hidden
    And the browser location is the repos path

  Scenario: Refresh after in-app open still closes to Repos with replace
    Given the End-to-End Fixture Repository is checked out
    When I add the Repository with the CLI
    And I open the Repos page
    And I open Repository settings from the card menu
    Then the browser location is the repository settings path
    When I refresh the page
    Then the Repository settings dialog is visible
    And the browser location is the repository settings path
    When I cancel the Repository settings dialog
    Then the Repository settings dialog is hidden
    And the browser location is the repos path

  Scenario: Missing Repository shows not-found and closes to Repos
    When I open a stale repository settings path
    Then the Repository not found dialog is visible
    And the browser location is a repository settings path
    And the Repos jobs tab is active
    When I close the Repository not found dialog
    Then the Repository not found dialog is hidden
    And the browser location is the repos path
